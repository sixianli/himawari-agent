#!/usr/bin/env python3
import argparse
import hashlib
import json
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path

MANIFEST_SCHEMA = "himawari-embedding-artifact.v1"
TOOLS = {"onnxruntime": "1.22.1", "onnx": "1.23.2"}
SOURCES = {
    "jina-embeddings-v5-text-small-retrieval-int8": {
        "repository": "jinaai/jina-embeddings-v5-text-small-retrieval",
        "revision": "6856e76bb72982e58de0620458a4e8b3614da340",
        "dimensions": 1024,
        "model": "onnx/model.onnx",
        "externalData": ["onnx/model.onnx_data"],
        "quantization": "dynamic-int8-per-channel",
        "files": {
            name: digest
            for digest, name in (
                ("463fb3fec2adf9c47a946626dc2a0884e43091f95466083fb1754950000a7c1a", "onnx/model.onnx"),
                ("0ae431b811baf89641ec67b690fb1d625c584d634c629362caf1e42438ca370e", "onnx/model.onnx_data"),
                ("aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4", "tokenizer.json"),
                ("9da9b391de9bb545e047bdfd5d9abefe32ee41937acf6c3b06aae33d85d0a4b4", "tokenizer_config.json"),
            )
        },
    },
    "qwen3-embedding-0.6b-int8": {
        "repository": "onnx-community/Qwen3-Embedding-0.6B-ONNX",
        "revision": "c25a394dd583836952667c12f008335071b3f43d",
        "dimensions": 1024,
        "model": "onnx/model_quantized.onnx",
        "externalData": [],
        "quantization": "none",
        "files": {
            name: digest
            for digest, name in (
                ("87cd124e0ef1fd1f223ebc283efccbaeac386d0b08344701c46975d0657b591f", "onnx/model_quantized.onnx"),
                ("def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a", "tokenizer.json"),
                ("977648852447cb6587327ff3205b0a84cf2fc9f05621d6c8e88a497caafab2e1", "tokenizer_config.json"),
            )
        },
    },
    "embeddinggemma-2-fp32": {
        "repository": "onnx-community/embeddinggemma-2-ONNX",
        "revision": "daa72c51243991dfcaf9f9137d2c573d8f7790c0",
        "dimensions": 768,
        "model": "onnx/model.onnx",
        "externalData": ["onnx/model.onnx_data"],
        "quantization": "none",
        "files": {
            name: digest
            for digest, name in (
                ("bc47de15f81208a5c99e5ab10f746d5e33b51ea228b7dc0bef9c133a94f1c1c3", "onnx/model.onnx"),
                ("9fd452bfc6916e5a92f080f8dada35598ca4512b21c65897d4c5974d5f9630a2", "onnx/model.onnx_data"),
                ("4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4", "tokenizer.json"),
                ("17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874", "tokenizer_config.json"),
            )
        },
    },
}


def fail(code, message):
    print(f"{code}：{message}", file=sys.stderr)
    sys.exit(2)


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url, target, expected):
    partial = target.with_name(target.name + ".partial")
    digest = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=120) as response, open(partial, "wb") as handle:
        for chunk in iter(lambda: response.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
            handle.write(chunk)
    if digest.hexdigest() != expected:
        partial.unlink()
        fail("EMBEDDING_SOURCE_DIGEST_MISMATCH", f"{url} 的 SHA-256 不对")
    partial.rename(target)


def obtain(source, relative, expected, source_dir, work):
    target = work / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if source_dir is not None:
        candidate = source_dir / relative
        if candidate.is_symlink():
            fail("EMBEDDING_SOURCE_SYMLINK", f"{candidate} 是符号链接")
        if candidate.is_file() and sha256_of(candidate) == expected:
            shutil.copyfile(candidate, target)
            return target
    url = f"https://huggingface.co/{source['repository']}/resolve/{source['revision']}/{relative}"
    download(url, target, expected)
    return target


def check_tools():
    try:
        import onnx
        import onnxruntime
    except ImportError:
        fail("EMBEDDING_TOOL_MISSING", f"需要 onnxruntime=={TOOLS['onnxruntime']} 和 onnx=={TOOLS['onnx']}")
    found = {"onnxruntime": onnxruntime.__version__, "onnx": onnx.__version__}
    if found != TOOLS:
        fail("EMBEDDING_TOOL_VERSION", f"工具版本 {found} 和要求的 {TOOLS} 不同，量化结果会不一样")


def build(model, output_root, source_dir):
    source = SOURCES.get(model)
    if source is None:
        fail("EMBEDDING_PROFILE_UNKNOWN", f"没有 {model} 的来源")
    if source["quantization"] != "none":
        check_tools()
    models_root = output_root / "models" / model
    models_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=models_root, prefix=".work-") as temporary:
        work = Path(temporary)
        fetched = {
            relative: obtain(source, relative, expected, source_dir, work / "source")
            for relative, expected in sorted(source["files"].items())
        }
        staging = work / "artifact"
        staging.mkdir()
        if source["quantization"] == "dynamic-int8-per-channel":
            from onnxruntime.quantization import QuantType, quantize_dynamic

            quantize_dynamic(
                str(fetched[source["model"]]),
                str(staging / "model.onnx"),
                weight_type=QuantType.QInt8,
                per_channel=True,
                use_external_data_format=False,
            )
        else:
            shutil.copyfile(fetched[source["model"]], staging / "model.onnx")
            for relative in source["externalData"]:
                shutil.copyfile(fetched[relative], staging / Path(relative).name)
        for name in ("tokenizer.json", "tokenizer_config.json"):
            shutil.copyfile(fetched[name], staging / name)
        files = {entry.name: sha256_of(entry) for entry in sorted(staging.iterdir())}
        manifest = {
            "schema": MANIFEST_SCHEMA,
            "model": model,
            "dimensions": source["dimensions"],
            "files": files,
            "source": {
                "repository": source["repository"],
                "revision": source["revision"],
                "files": source["files"],
                "quantization": source["quantization"],
            },
            "tools": TOOLS if source["quantization"] != "none" else {},
        }
        encoded = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
        (staging / "manifest.json").write_bytes(encoded)
        artifact = hashlib.sha256(encoded).hexdigest()
        final = models_root / artifact
        if final.exists():
            fail("EMBEDDING_ARTIFACT_EXISTS", f"{final} 已存在")
        staging.rename(final)
    print(json.dumps({"model": model, "artifactSha256": artifact, "directory": str(final), "files": files}))


def main():
    parser = argparse.ArgumentParser(description="生成本机向量模型文件目录和清单")
    parser.add_argument("--model", required=True, choices=sorted(SOURCES))
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--source-dir", type=Path)
    arguments = parser.parse_args()
    build(arguments.model, arguments.output_root.resolve(), arguments.source_dir)


if __name__ == "__main__":
    main()
