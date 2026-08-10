"use client";

import { useCallback } from "react";
import { useProfileEditorData } from "@/lib/profileEditorData";
import type { FocusedSection } from "@/lib/profileSections";
import { useUnsavedChangesGuard } from "@/lib/useUnsavedChangesGuard";
import { UnsavedChangesDialog } from "@/components/profile/UnsavedChangesDialog";
import { EducationEditor } from "./EducationEditor";
import { ExperienceEditor } from "./ExperienceEditor";
import { LinksEditor } from "./LinksEditor";
import { PersonalEditor } from "./PersonalEditor";
import { PreferencesEditor } from "./PreferencesEditor";
import { ProjectsEditor } from "./ProjectsEditor";
import { SkillsEditor } from "./SkillsEditor";
import { CredentialsEditor } from "./CredentialsEditor";
import { PublicationsEditor } from "./PublicationsEditor";
import { ApplicationPreferencesEditor } from "./ApplicationPreferencesEditor";

/**
 * Which endpoint each section commits to.
 *
 * `PUT /profile` and `PUT /profile/career` are both full overwrites of separate
 * documents, so a section saves through exactly one of them. Keeping the map
 * here means the unsaved-changes guard can save on the user's behalf without
 * each editor having to wire that up itself.
 */
const CAREER_SECTIONS = new Set<FocusedSection>([
  "education",
  "experience",
  "projects",
  "credentials",
  "publications"
]);

/**
 * One data load shared by whichever editor is showing.
 *
 * The hook lives here rather than inside each editor so a section only ever
 * issues one set of requests, and so every section commits through the same
 * save path. The unsaved-changes guard is mounted here for the same reason:
 * one implementation covers every section rather than seven copies that drift.
 */
export function SectionEditor({ section }: { section: FocusedSection }) {
  const editor = useProfileEditorData();
  const { dirty, saveCareer, saveProfile, reload } = editor;

  // The guard treats a resolved promise as server-confirmed success, so a
  // `false` return (the editor's "save failed" signal) has to become a
  // rejection — otherwise a failed save would navigate away and lose the edits.
  const save = useCallback(async () => {
    const ok = CAREER_SECTIONS.has(section) ? await saveCareer() : await saveProfile();
    if (!ok) {
      throw new Error("Your changes could not be saved. They are still here — try again.");
    }
  }, [section, saveCareer, saveProfile]);

  const guard = useUnsavedChangesGuard({ dirty, onSave: save, onDiscard: reload });

  return (
    <>
      {renderSection(section, editor)}
      <UnsavedChangesDialog guard={guard} />
    </>
  );
}

function renderSection(section: FocusedSection, editor: ReturnType<typeof useProfileEditorData>) {
  switch (section) {
    case "personal":
      return <PersonalEditor editor={editor} />;
    case "preferences":
      return <PreferencesEditor editor={editor} />;
    case "education":
      return <EducationEditor editor={editor} />;
    case "experience":
      return <ExperienceEditor editor={editor} />;
    case "projects":
      return <ProjectsEditor editor={editor} />;
    case "skills":
      return <SkillsEditor editor={editor} />;
    case "links":
      return <LinksEditor editor={editor} />;
    case "credentials":
      return <CredentialsEditor editor={editor} />;
    case "publications":
      return <PublicationsEditor editor={editor} />;
    case "application-preferences":
      return <ApplicationPreferencesEditor editor={editor} />;
  }
}
