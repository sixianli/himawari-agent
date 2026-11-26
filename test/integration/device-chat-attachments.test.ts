import {
  CHAT_ATTACHMENT_TEXT_CHARACTERS,
  CHAT_ATTACHMENTS_PER_MESSAGE,
  CHAT_IMAGE_DATA_URL_CHARACTERS,
} from "@himawari-agent/gateway-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentId,
  createThread,
  harness,
  ownerId,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
  send,
  signedRequest,
} from "../fixtures/device-api-harness.ts";

afterEach(removeDeviceHarnessDirectories);

const PHOTO = "data:image/png;base64,iVBORw0KGgo=";
const REQUEST = "AAAAAAAAAAAAAAAAAAAAAA";

type H = Awaited<ReturnType<typeof harness>>;
type Client = Awaited<ReturnType<typeof pairAndConfirm>>;

async function config(h: H, client: Client) {
  const response = await send(
    h,
    signedRequest(h, client, { method: "GET", path: "/api/device/v1/config" }),
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Record<string, unknown>;
}

async function attach(h: H, client: Client, body: Record<string, unknown>) {
  return send(
    h,
    signedRequest(h, client, {
      method: "POST",
      path: "/api/device/v1/attachments",
      body: JSON.stringify(body),
    }),
  );
}

async function stored(h: H, ref: string) {
  const payload = await h.repository.payloadStore(ownerId, agentId).get(ref);
  return { contentType: payload?.contentType, content: await h.readText(ref) };
}

describe("[ATTACH] iPhone chat attachments", () => {
  it("offers attachments in /config, stores a photo and a file the way the model reads them, and takes the message that names them", async () => {
    const h = await harness({ chatAttachments: { images: true } });
    const client = await pairAndConfirm(h);
    const bodyBytes = h.configuration.current.limits["device.request.body_bytes"];
    expect((await config(h, client))["attachments"]).toEqual({
      textCharacters: Math.min(CHAT_ATTACHMENT_TEXT_CHARACTERS, Math.floor((bodyBytes - 1024) / 3)),
      imageCharacters: Math.min(CHAT_IMAGE_DATA_URL_CHARACTERS, bodyBytes - 1024),
      perMessage: CHAT_ATTACHMENTS_PER_MESSAGE,
      messageCharacters: 64 * 1024,
    });

    const photo = await attach(h, client, {
      requestId: `${REQUEST}-0`,
      content: PHOTO,
      as: "image",
    });
    expect(photo.statusCode, photo.body).toBe(201);
    const photoRef = photo.json()["ref"] as string;
    expect(await stored(h, photoRef)).toEqual({
      contentType: "text/x-himawari-image",
      content: PHOTO,
    });
    const again = await attach(h, client, {
      requestId: `${REQUEST}-0`,
      content: PHOTO,
      as: "image",
    });
    expect(again.statusCode).toBe(201);
    expect(again.json()["ref"]).toBe(photoRef);

    const file = await attach(h, client, {
      requestId: `${REQUEST}-1`,
      content: "合同第一页：租期两年",
      as: "text",
    });
    expect(file.statusCode, file.body).toBe(201);
    const fileRef = file.json()["ref"] as string;
    expect(await stored(h, fileRef)).toEqual({
      contentType: "text/x-himawari-attachment",
      content: "合同第一页：租期两年",
    });

    await createThread(h, "thread-device-attach");
    const message = await send(
      h,
      signedRequest(h, client, {
        method: "POST",
        path: "/api/device/v1/messages",
        body: JSON.stringify({
          messageId: "device-message-attach-01",
          threadId: "thread-device-attach",
          expectedRevision: 1,
          text: `这是什么\n\n<file name="照片" ref="${photoRef}" bytes="10" kind="image"/>\n\n<file name="合同.pdf" ref="${fileRef}" bytes="30" kind="pdf"/>`,
        }),
      }),
    );
    expect(message.statusCode, message.body).toBe(200);
    expect(message.json()).toMatchObject({ type: "thread.command_result" });
    await h.repository.close();
  });

  it("does not offer or take photos when the chat model cannot read images", async () => {
    const h = await harness({ chatAttachments: { images: false } });
    const client = await pairAndConfirm(h);
    expect((await config(h, client))["attachments"]).toMatchObject({ imageCharacters: 0 });
    const photo = await attach(h, client, {
      requestId: `${REQUEST}-0`,
      content: PHOTO,
      as: "image",
    });
    expect(photo.statusCode).toBe(415);
    const file = await attach(h, client, {
      requestId: `${REQUEST}-1`,
      content: "笔记",
      as: "text",
    });
    expect(file.statusCode).toBe(201);
    await h.repository.close();
  });

  it("offers no attachments and has no upload route on a server without them", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    expect(await config(h, client)).not.toHaveProperty("attachments");
    const response = await attach(h, client, { requestId: REQUEST, content: "x", as: "text" });
    expect(response.statusCode).toBe(404);
    await h.repository.close();
  });

  it("refuses a malformed, oversized or non-image upload", async () => {
    const h = await harness({ chatAttachments: { images: true } });
    const client = await pairAndConfirm(h);
    const limits = (await config(h, client))["attachments"] as Record<string, number>;
    for (const [body, status] of [
      [{ requestId: REQUEST, content: "不是图片", as: "image" }, 400],
      [{ requestId: "short", content: "x", as: "text" }, 400],
      [{ requestId: REQUEST, content: "", as: "text" }, 400],
      [{ requestId: REQUEST, content: "x", as: "audio" }, 400],
      [{ requestId: REQUEST, content: "x", as: "text", extra: 1 }, 400],
      [
        {
          requestId: REQUEST,
          content: "字".repeat((limits["textCharacters"] ?? 0) + 1),
          as: "text",
        },
        413,
      ],
    ] as const) {
      const response = await attach(h, client, body);
      expect(response.statusCode, JSON.stringify(body).slice(0, 80)).toBe(status);
    }
    await h.repository.close();
  });
});
