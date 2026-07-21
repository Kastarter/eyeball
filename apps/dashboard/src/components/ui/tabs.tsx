"use client";

import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";

export type TabsKeyboardKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";

export function tabDestinationIndex(
  key: string,
  currentIndex: number,
  tabCount: number,
): number {
  if (tabCount <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return tabCount - 1;
  if (key === "ArrowLeft") return (currentIndex - 1 + tabCount) % tabCount;
  if (key === "ArrowRight") return (currentIndex + 1) % tabCount;
  return currentIndex;
}

export interface TabDefinition {
  content: ReactNode;
  id: string;
  label: string;
}

export interface TabsProps {
  ariaLabel: string;
  onValueChange: (value: string) => void;
  tabs: readonly TabDefinition[];
  value: string;
}

export function Tabs({ ariaLabel, onValueChange, tabs, value }: TabsProps) {
  const generatedId = useId().replaceAll(":", "");
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === value),
  );
  const selected = tabs[selectedIndex];

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    const destination = tabDestinationIndex(
      event.key,
      currentIndex,
      tabs.length,
    );
    const destinationTab = tabs[destination];
    if (destinationTab === undefined) return;
    onValueChange(destinationTab.id);
    buttonRefs.current[destination]?.focus();
  }

  if (selected === undefined) return null;
  const selectedTabId = `${generatedId}-tab-${selected.id}`;
  const selectedPanelId = `${generatedId}-panel-${selected.id}`;

  return (
    <div className="tabs">
      <div aria-label={ariaLabel} className="tabs__list" role="tablist">
        {tabs.map((tab, index) => {
          const active = index === selectedIndex;
          const tabId = `${generatedId}-tab-${tab.id}`;
          const panelId = `${generatedId}-panel-${tab.id}`;
          return (
            <button
              aria-controls={panelId}
              aria-selected={active}
              className="tabs__tab"
              id={tabId}
              key={tab.id}
              onClick={() => onValueChange(tab.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              ref={(node) => {
                buttonRefs.current[index] = node;
              }}
              role="tab"
              tabIndex={active ? 0 : -1}
              type="button"
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        aria-labelledby={selectedTabId}
        className="tabs__panel"
        id={selectedPanelId}
        role="tabpanel"
      >
        {selected.content}
      </div>
    </div>
  );
}
