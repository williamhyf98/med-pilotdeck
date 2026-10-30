type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
};

const isBlankText = (node: MdastNode): boolean => (
  node.type === 'text' && !(node.value ?? '').trim()
);

const isIgnorableInline = (node: MdastNode): boolean => (
  isBlankText(node) || node.type === 'break'
);

const isImageContent = (node: MdastNode): boolean => {
  if (node.type === 'image') return true;
  // `[![alt](image)](href)` — a link that only wraps images.
  if (node.type !== 'link' || !Array.isArray(node.children)) return false;
  const meaningful = node.children.filter((child) => !isIgnorableInline(child));
  return meaningful.length > 0 && meaningful.every((child) => child.type === 'image');
};

const isImageOnlyParagraph = (node: MdastNode): boolean => {
  if (node.type !== 'paragraph' || !Array.isArray(node.children)) return false;
  const meaningful = node.children.filter((child) => !isIgnorableInline(child));
  return meaningful.length > 0 && meaningful.every(isImageContent);
};

/**
 * Merge runs of image-only paragraphs into one paragraph so the renderer can
 * lay the images out on a single row. Each `![](url)` on its own line would
 * otherwise become a separate block and stack vertically.
 */
const groupSiblings = (node: MdastNode): void => {
  const children = node.children;
  if (!Array.isArray(children)) return;
  for (const child of children) groupSiblings(child);

  for (let index = 0; index < children.length; index += 1) {
    if (!isImageOnlyParagraph(children[index])) continue;
    let end = index + 1;
    while (end < children.length && isImageOnlyParagraph(children[end])) end += 1;
    if (end - index < 2) continue;
    const merged = children
      .slice(index, end)
      .flatMap((paragraph) => (paragraph.children ?? []).filter((child) => !isIgnorableInline(child)));
    children.splice(index, end - index, { type: 'paragraph', children: merged });
  }
};

export function remarkGroupImageParagraphs() {
  return (tree: MdastNode) => {
    groupSiblings(tree);
  };
}
