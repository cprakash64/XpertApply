import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Alert, Button, Card, Chip, Input, Select, StatusBadge, Tag, Textarea } from "@/components/ui";

afterEach(cleanup);

describe("canonical Button", () => {
  it.each(["primary", "secondary", "ghost", "destructive"] as const)(
    "renders the %s semantic variant with canonical focus behavior",
    (variant) => {
      render(<Button variant={variant}>{variant}</Button>);
      const button = screen.getByRole("button", { name: variant });
      expect(button.className).toContain("ds-focus-ring");
      expect(button.className).toContain(`action-${variant === "destructive" ? "destructive" : variant}`);
      expect(button).toHaveAttribute("type", "button");
    }
  );

  it.each(["sm", "md", "lg", "icon"] as const)("supports the %s size", (size) => {
    const button = size === "icon"
      ? <Button size="icon" aria-label="Settings">icon</Button>
      : <Button size={size}>{size}</Button>;
    render(button);
    const height = { sm: "h-9", md: "h-10", lg: "h-11", icon: "h-10" }[size];
    expect(screen.getByRole("button")).toHaveClass(height);
  });

  it("exposes loading and disabled states without losing its accessible name", () => {
    render(<Button loading aria-busy={false}>Save profile</Button>);
    const button = screen.getByRole("button", { name: "Save profile" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).not.toHaveClass("opacity-70");
  });
});

describe("canonical fields", () => {
  it("associates an Input label, hint, and required state", () => {
    render(<Input label="Email" hint="Used for applications" required placeholder="you@example.com" />);
    const input = screen.getByLabelText("Email *");
    expect(input).toBeRequired();
    expect(input).toHaveAccessibleDescription("Used for applications");
  });

  it("associates field errors and aria-invalid without exposing raw payloads", () => {
    render(<Input label="Portfolio URL" error="Enter a valid URL." aria-invalid={false} />);
    const input = screen.getByLabelText("Portfolio URL");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Error: Enter a valid URL.");
  });

  it("supports disabled, read-only, Textarea, and native Select semantics", () => {
    render(
      <>
        <Input label="Disabled" disabled />
        <Input label="Read only" readOnly value="Existing value" onChange={() => undefined} />
        <Textarea label="Summary" hint="Keep it concise" />
        <Select label="Workplace" defaultValue="remote">
          <option value="remote">Remote</option>
        </Select>
      </>
    );
    expect(screen.getByLabelText("Disabled")).toBeDisabled();
    expect(screen.getByLabelText("Read only")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Summary").tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText("Workplace").tagName).toBe("SELECT");
  });
});

describe("canonical card and badge semantics", () => {
  it.each(["standard", "interactive", "raised", "subtle"] as const)("supports %s cards", (variant) => {
    render(<Card variant={variant}>{variant}</Card>);
    expect(screen.getByText(variant).className).toContain("rounded-card");
  });

  it("keeps interactive Card a visual shell around a semantic control", () => {
    render(<Card variant="interactive"><button type="button">Open job</button></Card>);
    const button = screen.getByRole("button", { name: "Open job" });
    expect(button.parentElement).not.toHaveAttribute("role");
    expect(button.parentElement).not.toHaveAttribute("tabindex");
  });

  it("keeps a selectable Chip keyboard-operable and exposes selected state", async () => {
    const onClick = vi.fn();
    render(<Chip selected onClick={onClick}>Remote</Chip>);
    const chip = screen.getByRole("button", { name: "Remote" });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(chip).not.toHaveClass("opacity-70");
    chip.focus();
    await userEvent.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps Tag non-interactive and StatusBadge explicitly toned", () => {
    render(
      <>
        <Tag>Python</Tag>
        <StatusBadge tone="success">Offer</StatusBadge>
      </>
    );
    expect(screen.getByText("Python").tagName).toBe("SPAN");
    expect(screen.getByText("Offer")).toHaveClass("text-status-success");
  });
});

describe("canonical Alert", () => {
  it.each(["info", "success", "warning"] as const)("announces %s information as status", (tone) => {
    render(<Alert tone={tone} title="Update">Details</Alert>);
    expect(screen.getByRole("status")).toHaveTextContent("UpdateDetails");
  });

  it("announces danger urgently and keeps the icon decorative", () => {
    render(<Alert tone="danger" title="Could not save">Try again.</Alert>);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Could not save");
    expect(alert.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
