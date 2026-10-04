/**
 * The Workflow / Live session switcher on its own (ANT-267). How it moves the
 * workspace is covered with the Workflow screen; this is what it says.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceTabs, type WorkspaceTabsProps } from "./WorkspaceTabs.js";

function show(props: Partial<WorkspaceTabsProps> = {}) {
  const onSelect = vi.fn();
  render(
    <div className="topbar">
      <WorkspaceTabs active="workflow" liveEnabled={false} liveNow={false} onSelect={onSelect} {...props} />
    </div>,
  );
  return { onSelect, live: screen.getByRole("tab", { name: "Live session" }) };
}

afterEach(cleanup);

describe("the workspace switcher", () => {
  it("keeps the Live tab with no session, disabled, and says why", () => {
    const { onSelect, live } = show();
    expect(screen.getByRole("tablist").getAttribute("aria-label")).toBe("Workspace");
    expect(live.getAttribute("aria-disabled")).toBe("true");
    expect(live.getAttribute("title")).toBe(
      "No session is running this workflow yet. Copy the prompt and start one.",
    );
    expect(live.querySelector(".ws-tab-dot.is-live")).toBeNull();

    fireEvent.click(live);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("opens a session that is there, and pulses only while it is live", () => {
    const { onSelect, live } = show({ liveEnabled: true, liveNow: true });
    expect(live.getAttribute("aria-disabled")).toBeNull();
    expect(live.getAttribute("title")).toBe("The workflow stays open in its own tab");
    expect(live.querySelector(".ws-tab-dot.is-live")).toBeTruthy();
    fireEvent.click(live);
    expect(onSelect).toHaveBeenCalledWith("live");

    cleanup();
    // A finished session can still be opened; it is just not called live.
    const finished = show({ liveEnabled: true, liveNow: false });
    expect(finished.live.getAttribute("aria-disabled")).toBeNull();
    expect(finished.live.querySelector(".ws-tab-dot.is-live")).toBeNull();
    expect(finished.live.getAttribute("title")).toBe(
      "See what the session did. The workflow stays open in its own tab",
    );
  });

  it("marks the tab in front and does nothing when it is chosen again", () => {
    const { onSelect } = show({ active: "live", liveEnabled: true, liveNow: true });
    const live = screen.getByRole("tab", { name: "Live session", selected: true });
    expect(live.tabIndex).toBe(0);
    expect(screen.getByRole("tab", { name: "Workflow", selected: false }).tabIndex).toBe(-1);
    fireEvent.click(live);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps the arrows on the Workflow tab while Live cannot be chosen", () => {
    show();
    const workflow = screen.getByRole("tab", { name: "Workflow" });
    workflow.focus();
    fireEvent.keyDown(workflow, { key: "ArrowRight" });
    expect(document.activeElement).toBe(workflow);
  });
});
