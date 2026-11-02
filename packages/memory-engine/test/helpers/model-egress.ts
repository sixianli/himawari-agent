import { ModelEgress } from "@himawari-agent/application";

export function testModelEgress(): ModelEgress {
  return new ModelEgress({
    key: async () => new Uint8Array([1, 2, 3, 4]),
    sign: (key, message) => {
      let hash = key[0] ?? 0;
      const out = new Uint8Array(8);
      for (const character of message) {
        hash = (hash * 131 + character.charCodeAt(0)) % 2147483647;
        out[hash % 8] = (out[hash % 8] ?? 0) ^ (hash & 255);
      }
      return out;
    },
  });
}
