import { AppShell } from "@/components/AppShell";
import { TrackerClient } from "@/components/TrackerClient";

export default function TrackerPage() {
  return (
    <AppShell>
      {/* The active navigation item already says where you are, so there is no visible title, breadcrumb or introduction.
          The h1 stays for screen readers and for the document outline. */}
      <h1 className="sr-only">Applications</h1>
      <TrackerClient />
    </AppShell>
  );
}
