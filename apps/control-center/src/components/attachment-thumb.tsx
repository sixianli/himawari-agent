import { useEffect, useState } from "react";
import { imageOf } from "../attachment-image.js";
import { LineIcon } from "./answer-footer.js";

export function AttachmentThumb({
  imageRef,
  name,
  readImage,
}: {
  readonly imageRef: string;
  readonly name: string;
  readonly readImage?: ((ref: string) => Promise<string>) | undefined;
}) {
  const [source, setSource] = useState<string>();
  useEffect(() => {
    if (!readImage) return;
    let active = true;
    imageOf(imageRef, readImage).then(
      (dataUrl) => {
        if (active) setSource(dataUrl);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [imageRef, readImage]);
  return source ? (
    <img className="attachment-image" src={source} alt={name} />
  ) : (
    <span className="attachment-image is-empty">
      <LineIcon name="image" />
    </span>
  );
}
