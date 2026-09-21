#!/usr/bin/env bash
# Половина деплою, що живе у WSL: збірка anchor-cli 0.32.1 тим самим Agave, що й
# CI, і `anchor deploy` операторським ключем. Перший запуск створює програму,
# наступні оновлюють її на місці (CLI сам розширює акаунт під більший .so).
set -euo pipefail

KEY=${1:?шлях до операторського ключа відносно кореня репо}
RPC=${2:-https://api.devnet.solana.com}

AGAVE=$HOME/.local/share/solana/install/releases/4.2.0/solana-release/bin
ANCHOR=$HOME/.avm/bin/anchor-0.32.1
export PATH=$AGAVE:$PATH

[ -x "$AGAVE/solana" ] || { echo "немає Agave 4.2.0 у $AGAVE — та сама версія, що в CI"; exit 1; }
[ -x "$ANCHOR" ] || { echo "немає $ANCHOR — avm install 0.32.1"; exit 1; }
[ -f "$KEY" ] || { echo "немає ключа $KEY"; exit 1; }
KEY=$(realpath "$KEY")

cd packages/program

PROGRAM_ID=$(sed -n 's/^contentledger = "\(.*\)"/\1/p' Anchor.toml | head -1)
PROGRAM_KEYPAIR=target/deploy/contentledger-keypair.json
OPERATOR=$(solana-keygen pubkey "$KEY")

# anchor deploy бере адресу з цього файла; чужий ключ тут означав би другу
# програму під тією ж збіркою.
[ -f "$PROGRAM_KEYPAIR" ] || { echo "немає $PROGRAM_KEYPAIR — без нього деплой піде на іншу адресу"; exit 1; }
[ "$(solana-keygen pubkey "$PROGRAM_KEYPAIR")" = "$PROGRAM_ID" ] \
  || { echo "$PROGRAM_KEYPAIR не відповідає declare_id! $PROGRAM_ID"; exit 1; }

"$ANCHOR" build
SO=target/deploy/contentledger.so
SIZE=$(stat -c %s "$SO")
LOCAL_SHA=$(sha256sum "$SO" | cut -d' ' -f1)
echo "збірка     $SIZE байт · sha256 $LOCAL_SHA"

# Буфер під повний .so потрібен і на апгрейд: рента ProgramData = розмір + 45
# байт заголовка. Запас 0.1 SOL — на комісії, Config і 15 акаунтів реєстру.
NEED=$(solana rent $((SIZE + 45)) --lamports -u "$RPC" | sed -n 's/.*: \([0-9]*\) lamports/\1/p')
NEED=$((NEED + 100000000))
BALANCE=$(solana balance "$KEY" --lamports -u "$RPC" | cut -d' ' -f1)
echo "оператор   $OPERATOR · баланс $BALANCE · потрібно $NEED lamports"
if [ "$BALANCE" -lt "$NEED" ]; then
  solana airdrop 2 "$OPERATOR" -u "$RPC" || true
  BALANCE=$(solana balance "$KEY" --lamports -u "$RPC" | cut -d' ' -f1)
  [ "$BALANCE" -ge "$NEED" ] || { echo "бракує SOL: faucet.solana.com або переказ на $OPERATOR"; exit 1; }
fi

"$ANCHOR" deploy --provider.cluster "$RPC" --provider.wallet "$KEY"

# Дамп доповнений нулями до розміру акаунта, тож порівнюється перших SIZE байт.
DUMP=$(mktemp)
solana program dump "$PROGRAM_ID" "$DUMP" -u "$RPC" >/dev/null
CHAIN_SHA=$(head -c "$SIZE" "$DUMP" | sha256sum | cut -d' ' -f1)
rm -f "$DUMP"
[ "$CHAIN_SHA" = "$LOCAL_SHA" ] || { echo "у мережі інший бінарник: $CHAIN_SHA"; exit 1; }

AUTHORITY=$(solana program show "$PROGRAM_ID" -u "$RPC" | sed -n 's/^Authority: //p')
[ "$AUTHORITY" = "$OPERATOR" ] || { echo "upgrade authority $AUTHORITY ≠ оператор $OPERATOR"; exit 1; }
echo "програма   $PROGRAM_ID · у мережі та сама збірка · upgrade authority = оператор"
