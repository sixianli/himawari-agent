#!/usr/bin/env python3
import json
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

DIMENSIONS = 1024
VOCABULARY = 256


def byte_alphabet():
    printable = list(range(ord("!"), ord("~") + 1)) + list(range(0xA1, 0xAC + 1)) + list(range(0xAE, 0xFF + 1))
    codes = printable[:]
    extra = 0
    for byte in range(256):
        if byte not in printable:
            printable.append(byte)
            codes.append(256 + extra)
            extra += 1
    return {byte: chr(code) for byte, code in zip(printable, codes)}


def tokenizer():
    alphabet = byte_alphabet()
    vocab = {alphabet[byte]: byte for byte in range(256)}
    return {
        "version": "1.0",
        "truncation": None,
        "padding": None,
        "added_tokens": [],
        "normalizer": None,
        "pre_tokenizer": {"type": "ByteLevel", "add_prefix_space": False, "trim_offsets": False, "use_regex": False},
        "post_processor": None,
        "decoder": {"type": "ByteLevel", "add_prefix_space": False, "trim_offsets": False, "use_regex": False},
        "model": {
            "type": "BPE",
            "dropout": None,
            "unk_token": None,
            "continuing_subword_prefix": None,
            "end_of_word_suffix": None,
            "fuse_unk": False,
            "byte_fallback": False,
            "ignore_merges": False,
            "vocab": vocab,
            "merges": [],
        },
    }


def model():
    generator = np.random.default_rng(20261111)
    weights = generator.integers(-127, 128, size=(VOCABULARY, DIMENSIONS), dtype=np.int8)
    scale = np.array(1 / 127, dtype=np.float32)
    nodes = [
        helper.make_node("DequantizeLinear", ["weights", "scale"], ["table"]),
        helper.make_node("Gather", ["table", "input_ids"], ["gathered"], axis=0),
        helper.make_node("Cast", ["attention_mask"], ["mask"], to=TensorProto.FLOAT),
        helper.make_node("Unsqueeze", ["mask", "last_axis"], ["mask3"]),
        helper.make_node("Mul", ["gathered", "mask3"], ["masked"]),
        helper.make_node("CumSum", ["masked", "sequence_axis"], ["last_hidden_state"]),
    ]
    graph = helper.make_graph(
        nodes,
        "himawari-test-embedding",
        [
            helper.make_tensor_value_info("input_ids", TensorProto.INT64, [1, "sequence"]),
            helper.make_tensor_value_info("attention_mask", TensorProto.INT64, [1, "sequence"]),
        ],
        [helper.make_tensor_value_info("last_hidden_state", TensorProto.FLOAT, [1, "sequence", DIMENSIONS])],
        [
            numpy_helper.from_array(weights, "weights"),
            numpy_helper.from_array(scale, "scale"),
            numpy_helper.from_array(np.array([2], dtype=np.int64), "last_axis"),
            numpy_helper.from_array(np.array(1, dtype=np.int64), "sequence_axis"),
        ],
    )
    built = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)], producer_name="himawari")
    built.ir_version = 8
    onnx.checker.check_model(built)
    return built


def main():
    output = Path(sys.argv[1])
    output.mkdir(parents=True, exist_ok=True)
    onnx.save(model(), output / "model.onnx")
    (output / "tokenizer.json").write_text(json.dumps(tokenizer(), ensure_ascii=False, sort_keys=True) + "\n")
    (output / "tokenizer_config.json").write_text(json.dumps({"tokenizer_class": "PreTrainedTokenizerFast"}) + "\n")


if __name__ == "__main__":
    main()
