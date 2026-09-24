import { Fragment, type ReactNode } from "react";

/** Renders a translated string, swapping `{name}` placeholders for React nodes (e.g. <code>). */
export function rich(text: string, nodes: Record<string, ReactNode>): ReactNode {
  return text.split(/(\{\w+\})/g).map((part, index) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    return name && name in nodes ? <Fragment key={index}>{nodes[name]}</Fragment> : <Fragment key={index}>{part}</Fragment>;
  });
}
