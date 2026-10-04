/**
 * Workflow and Live session, as two tabs of one workspace (ANT-267).
 *
 * The Live Session page used to be pushed on top of the workflow, and its Back
 * was the only way to the canvas — and the live chip the only way back again.
 * Looking at the plan and returning to the session it is driving is the most
 * ordinary thing to want while a session runs, so the two are now siblings: one
 * switcher in each top bar, and switching never stops the observation.
 *
 * The Live tab is always there, so the workspace has the same shape before a
 * session starts as after. Until there is a session to show it is disabled and
 * says why, rather than disappearing — a control that is not there teaches
 * nothing about what would make it appear.
 *
 * The dot claims a live session only while there is one. A finished run can
 * still be opened from here — days later too, from the ending main keeps
 * (ANT-275) — and pulsing red over it would say it was running.
 */

import { useRef, type KeyboardEvent } from "react";

export type WorkspaceTab = "workflow" | "live";

export type WorkspaceTabsProps = {
  active: WorkspaceTab;
  /** Whether there is a session to switch to. The Workflow tab always works. */
  liveEnabled: boolean;
  /** Whether that session is live right now, which is what the red dot says. */
  liveNow: boolean;
  onSelect: (tab: WorkspaceTab) => void;
};

const LIVE_TITLE = "The workflow stays open in its own tab";
const ENDED_TITLE = "See what the session did. The workflow stays open in its own tab";
const NO_LIVE_TITLE = "No session is running this workflow yet. Copy the prompt and start one.";

export function WorkspaceTabs({ active, liveEnabled, liveNow, onSelect }: WorkspaceTabsProps) {
  const list = useRef<HTMLDivElement>(null);
  const enabled = (tab: WorkspaceTab) => tab === "workflow" || liveEnabled;

  const select = (tab: WorkspaceTab) => {
    if (!enabled(tab) || tab === active) return;
    // Each screen has its own bar, so the button that was pressed is about to
    // be hidden with its screen. Keyboard focus follows the reader to the same
    // tab in the bar they land on rather than falling back to the page.
    const hadFocus = list.current?.contains(document.activeElement) ?? false;
    onSelect(tab);
    if (!hadFocus) return;
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`.app:not([hidden]) .ws-tabs [data-tab="${tab}"]`)
        ?.focus();
    });
  };

  /* Arrows move between the tabs that can be chosen; Enter and Space choose. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const tabs = [...(list.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].filter(
      (tab) => tab.getAttribute("aria-disabled") !== "true",
    );
    const at = tabs.indexOf(document.activeElement as HTMLElement);
    if (tabs.length < 2 || at < 0) return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    tabs[(at + step + tabs.length) % tabs.length].focus();
  };

  const tab = (id: WorkspaceTab, label: string) => {
    const selected = active === id;
    const disabled = !enabled(id);
    return (
      <button
        type="button"
        role="tab"
        className="ws-tab"
        data-tab={id}
        aria-selected={selected}
        aria-disabled={disabled ? true : undefined}
        tabIndex={selected ? 0 : -1}
        {...(id === "live" ? { title: disabled ? NO_LIVE_TITLE : liveNow ? LIVE_TITLE : ENDED_TITLE } : {})}
        onClick={() => select(id)}
      >
        {id === "live" ? (
          <i className={`ws-tab-dot${liveEnabled && liveNow ? " is-live" : ""}`} aria-hidden="true" />
        ) : null}
        {label}
      </button>
    );
  };

  return (
    <div className="ws-tabs" role="tablist" aria-label="Workspace" ref={list} onKeyDown={onKeyDown}>
      {tab("workflow", "Workflow")}
      {tab("live", "Live session")}
    </div>
  );
}
