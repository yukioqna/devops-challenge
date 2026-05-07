# Problem 1 — CLI Solution

## Command

```bash
jq -r 'select(.symbol=="TSLA" and .side=="sell") | .order_id' ./transaction-log.txt \
  | xargs -r -I{} curl -sS "https://example.com/api/{}" \
  > ./output.txt
```

## Prerequisites

```bash
sudo apt install -y jq curl   # both available in Ubuntu 24.04 default repos
```

## Explanation

The input file is NDJSON, with one JSON object per line. `jq` filters records where
`symbol` is `TSLA` and `side` is `sell`, then outputs only the `order_id`.

`xargs` passes each order ID into `curl`, replacing `{}` in the URL. The HTTP responses
are written to `./output.txt`.