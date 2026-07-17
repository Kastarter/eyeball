"use client";

import { useEffect, useState } from "react";
import type { PageHeading } from "../lib/content";

export function OnThisPage({ headings }: { headings: PageHeading[] }) {
  const [activeId, setActiveId] = useState(headings[0]?.id ?? "");

  useEffect(() => {
    const elements = headings
      .map((heading) => document.getElementById(heading.id))
      .filter((element): element is HTMLElement => element !== null);

    if (elements.length === 0) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const firstVisible = visible[0]?.target;
        if (firstVisible instanceof HTMLElement) {
          setActiveId(firstVisible.id);
        }
      },
      { rootMargin: "-96px 0px -72%", threshold: [0, 1] },
    );

    for (const element of elements) {
      observer.observe(element);
    }

    const updateFromScroll = () => {
      const passed = elements.filter(
        (element) => element.getBoundingClientRect().top <= 118,
      );
      setActiveId(passed.at(-1)?.id ?? elements[0]?.id ?? "");
    };
    updateFromScroll();

    return () => observer.disconnect();
  }, [headings]);

  if (headings.length === 0) {
    return null;
  }

  return (
    <nav aria-label="On this page" className="toc">
      <p className="toc__title">On this page</p>
      <ol>
        {headings.map((heading) => (
          <li
            className={heading.level === 3 ? "toc__nested" : undefined}
            key={heading.id}
          >
            <a
              aria-current={activeId === heading.id ? "location" : undefined}
              className={activeId === heading.id ? "is-active" : undefined}
              href={`#${heading.id}`}
            >
              {heading.title}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
