// Image bytes cannot travel through a PTY; Codex accepts a pasted local image path.
async function pasteImages(term, images, saveImage) {
  for (const image of images) {
    const file = await saveImage(image);
    // Quotes preserve spaces in the plugin data folder; no Enter submits the prompt.
    term.paste(JSON.stringify(file) + " ");
  }
  return true;
}

/** Claim image events before xterm consumes their empty text/plain representation. */
function pasteImageEvent(event, term, saveImage) {
  const images = Array.from(event.clipboardData?.items || [])
    .filter((item) => item.type.startsWith("image/"))
    .map((item) => item.getAsFile()).filter(Boolean);
  if (!images.length) return null;
  event.preventDefault();
  event.stopImmediatePropagation();
  return pasteImages(term, images, saveImage);
}

export { pasteImages, pasteImageEvent };
