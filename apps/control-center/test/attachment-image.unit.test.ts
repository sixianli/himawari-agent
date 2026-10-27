// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dataUrlBytes, imageOf, rememberImage, scaledSize } from "../src/attachment-image.js";
import { AttachmentThumb } from "../src/components/attachment-thumb.js";
import { ChatComposer } from "../src/components/chat-composer.js";
import { type DraftAttachment, joinDraft, splitDraft } from "../src/draft-attachments.js";
import { GatewayClient } from "../src/gateway-client.js";
import { messages as en } from "../src/i18n/resources/en.js";
import { messages as ja } from "../src/i18n/resources/ja.js";
import { messages as zh } from "../src/i18n/resources/zh-CN.js";

const photo: DraftAttachment = {
  name: "街景.jpg",
  ref: "payload:http:photo",
  bytes: 310_000,
  kind: "image",
  truncated: false,
};

const ids = (id: string, values?: Record<string, string | number>) =>
  values ? `${id}(${Object.values(values).join(",")})` : id;

const composer = (images: boolean) =>
  renderToStaticMarkup(
    createElement(ChatComposer, {
      draft: joinDraft("这是哪里", [photo]),
      onDraft: () => {},
      onSubmit: () => {},
      onUpload: async () => "payload:http:new",
      connected: true,
      pending: false,
      model: "DeepSeek V4.1 Flash",
      models: [
        {
          ref: "deepseek",
          model: "deepseek/deepseek-v4.1-flash",
          name: "DeepSeek V4.1 Flash",
          provider: "vercel-ai-gateway",
          thinkingLevels: [],
          images,
        },
      ],
      modelRef: "deepseek",
      thinkingLevel: "",
      onModelChange: () => {},
      onThinkingChange: () => {},
      message: ids,
    }),
  );

describe("[UI-17] images attached to a message", () => {
  it("keeps an image as a short reference in the message, like any other file", () => {
    const draft = joinDraft("这是哪里", [photo]);
    expect(draft).toBe(
      '这是哪里\n\n<file name="街景.jpg" ref="payload:http:photo" bytes="310000" kind="image"/>',
    );
    expect(splitDraft(draft)).toEqual({ text: "这是哪里", files: [photo] });
  });

  it("shrinks a large photo to 1568 pixels on its long side and keeps small ones as they are", () => {
    expect(scaledSize(4032, 3024)).toEqual({ width: 1568, height: 1176 });
    expect(scaledSize(3024, 4032)).toEqual({ width: 1176, height: 1568 });
    expect(scaledSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(dataUrlBytes("data:image/png;base64,iVBORw0KGgo=")).toBe(8);
  });

  it("shows an image as a square thumbnail and warns only when the model cannot see images", () => {
    const seeing = composer(true);
    expect(seeing).toContain('class="is-image" title="街景.jpg · 302.7 KB"');
    expect(seeing).toContain('aria-label="chat.removeAttachment(街景.jpg)"');
    expect(seeing).toContain("image/png,image/jpeg,image/webp,image/gif");
    expect(seeing).not.toContain("chat.imageUnsupported");
    expect(composer(false)).toContain(
      '<p class="attachment-note">chat.imageUnsupported(DeepSeek V4.1 Flash)</p>',
    );
  });

  it("loads a thumbnail once per image and reuses an image that was just uploaded", async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      return "data:image/png;base64,iVBORw0KGgo=";
    };
    rememberImage("payload:http:uploaded", "data:image/jpeg;base64,/9j/");
    expect(await imageOf("payload:http:uploaded", read)).toBe("data:image/jpeg;base64,/9j/");
    expect(reads).toBe(0);
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(AttachmentThumb, {
          imageRef: "payload:http:stored",
          name: "旧图.png",
          readImage: read,
        }),
      );
    });
    expect(host.innerHTML).toBe(
      '<img class="attachment-image" alt="旧图.png" src="data:image/png;base64,iVBORw0KGgo=">',
    );
    await imageOf("payload:http:stored", read);
    expect(reads).toBe(1);
    act(() => root.unmount());
  });

  it("uploads only image data URLs to the image endpoint and reads them back by type", async () => {
    const calls: { url: string; body: string }[] = [];
    const client = new GatewayClient({
      csrfToken: () => "csrf-01",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: String(init?.body) });
        return String(url).endsWith("/read")
          ? new Response(
              JSON.stringify({
                content: "data:image/png;base64,iVBORw0KGgo=",
                dataClassification: "private",
                contentType: "text/x-himawari-image",
              }),
            )
          : new Response(JSON.stringify({ payloadRef: "payload-image-01" }), { status: 201 });
      }) as typeof fetch,
    });
    expect(await client.protectImage("data:image/jpeg;base64,/9j/", "private", "image-a")).toBe(
      "payload-image-01",
    );
    expect(calls[0]?.url).toBe("/api/payload/v1/image");
    await expect(client.protectImage("data:image/svg+xml;base64,PHN2Zz4=")).rejects.toThrow(
      "CONTROL_CENTER_PAYLOAD_INVALID",
    );
    expect(await client.readImage("payload-image-01")).toBe("data:image/png;base64,iVBORw0KGgo=");
    await expect(client.readText("payload-image-01")).rejects.toThrow(
      "CONTROL_CENTER_RESPONSE_INVALID",
    );
    expect(calls).toHaveLength(3);
  });

  it.each([
    ["zh-CN", zh],
    ["en", en],
    ["ja", ja],
  ])("has the image texts in %s", (_locale, catalog) => {
    expect(catalog["chat.imageUnsupported"]).toContain("{model}");
    expect(catalog["chat.attachHint"]).toMatch(/PNG/);
    expect(catalog["chat.attachmentUnsupported"]).toMatch(/HEIC/);
  });
});
