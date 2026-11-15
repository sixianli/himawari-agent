#!/bin/sh
set -eu
dest="${1:?usage: fetch-corpora.sh DIR}"
fleurs="https://huggingface.co/datasets/google/fleurs/resolve/main/data"
mkdir -p "$dest/fleurs"
for lang in cmn_hans_cn ja_jp en_us; do
  folder="$dest/fleurs/$lang"
  mkdir -p "$folder/audio"
  [ -f "$folder/test.tsv" ] || curl -fL -o "$folder/test.tsv" "$fleurs/$lang/test.tsv"
  [ -d "$folder/audio/test" ] || curl -fL "$fleurs/$lang/audio/test.tar.gz" | tar -xz -C "$folder/audio"
done
[ -d "$dest/LibriSpeech/test-clean" ] || curl -fL https://www.openslr.org/resources/12/test-clean.tar.gz | tar -xz -C "$dest"
du -sh "$dest"
