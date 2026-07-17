import type { ReactNode } from "react";
import { isValidElement } from "react";

const FENCED_BLOCK = /```[\s\S]*?```/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

export function removeFencedCode(source: string): string {
  return source.replace(FENCED_BLOCK, "");
}

export function removeHtmlComments(source: string): string {
  return source.replace(HTML_COMMENT, "");
}

export function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugifyHeading(value: string): string {
  const slug = stripInlineMarkdown(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

  return slug || "section";
}

export function reactNodeToText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(reactNodeToText).join("");
  }

  if (isValidElement<{ children?: ReactNode }>(node)) {
    return reactNodeToText(node.props.children);
  }

  return "";
}
