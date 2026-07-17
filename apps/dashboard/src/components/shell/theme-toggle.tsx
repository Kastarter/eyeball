"use client";

import { useEffect, useState } from "react";
import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";

type Theme = "dark" | "light";

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const saved = window.localStorage.getItem("eyeball-theme");
    const initial =
      saved === "dark" || saved === "light" ? saved : systemTheme();
    setTheme(initial);
    document.documentElement.dataset.theme = initial;
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem("eyeball-theme", next);
  }

  const nextTheme = theme === "dark" ? "light" : "dark";
  return (
    <Button
      aria-label={`Use ${nextTheme} theme`}
      className="icon-button"
      icon={<Icon name={theme === "dark" ? "sun" : "moon"} />}
      onClick={toggleTheme}
      size="small"
      title={`Use ${nextTheme} theme`}
      variant="ghost"
    >
      <span className="visually-hidden">Use {nextTheme} theme</span>
    </Button>
  );
}
