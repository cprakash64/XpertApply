"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  cleanAward,
  cleanCertification,
  cleanEducation,
  cleanPublication,
  cleanExperience,
  cleanProject,
  emptyCareer,
  normalizeAwardList,
  normalizeCertificationList,
  normalizeEducationList,
  normalizePublicationList,
  normalizeExperienceList,
  normalizeProjectList,
  type CareerForm
} from "@/lib/careerRecords";
import {
  emptyProfile,
  normalizeProfile,
  profileToWire,
  type ProfileForm,
  type ProfileWire
} from "@/lib/profileForm";

/**
 * Load + save for the focused profile editors.
 *
 * **Why explicit Save/Cancel rather than autosave.** `PUT /profile/career` is
 * not a patch: the handler deletes every Education, Experience, Project,
 * Certification and Award row for the user and re-inserts the payload. Firing
 * that from a debounce while someone is mid-sentence means a dropped request or
 * a stale tab can delete real career history, and it would write half-typed
 * records as though the user had confirmed them. `PUT /profile` is likewise a
 * full overwrite and rejects a missing first/last name, so a partial personal
 * edit cannot be saved on its own either.
 *
 * So each section commits explicitly, and the status is only ever reported from
 * the server's response — never optimistically.
 *
 * Sections are still independent: saving Experience does not require the user
 * to revisit Links. That works because every save sends the *whole* current
 * document for the endpoint it touches, which is what these full-overwrite
 * endpoints require.
 */

export type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "error"; message: string };

export type ProfileEditorData = {
  form: ProfileForm;
  career: CareerForm;
};

export type ProfileEditorState = {
  data: ProfileEditorData | null;
  loading: boolean;
  loadError: string;
  reload: () => void;
  save: SaveState;
  /** Clears a "saved"/"error" banner, e.g. when the user edits again. */
  resetSave: () => void;
  setForm: (update: (current: ProfileForm) => ProfileForm) => void;
  setCareer: (update: (current: CareerForm) => CareerForm) => void;
  /** Commits the profile record (and the structured name). */
  saveProfile: () => Promise<boolean>;
  /** Commits all career tables. */
  saveCareer: () => Promise<boolean>;
  /** True when the section has unsaved edits. */
  dirty: boolean;
  markPristine: () => void;
};

export function useProfileEditorData(): ProfileEditorState {
  const [data, setData] = useState<ProfileEditorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [dirty, setDirty] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const mounted = useRef(true);
  // Lets the save handlers read the freshest state without every field being a
  // dependency. Synced in an effect rather than during render — a ref written
  // while rendering is not safe under concurrent rendering, and the saves only
  // ever run from user events, which are after commit.
  const dataRef = useRef<ProfileEditorData | null>(null);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    mounted.current = true;
    Promise.all([
      api<{ profile: ProfileWire | null }>("/profile"),
      api<Partial<CareerForm>>("/profile/career"),
      // Email lives on the account record, not the profile.
      api<{ email?: string }>("/auth/me").catch(() => ({ email: "" }))
    ])
      .then(([profileResult, careerResult, account]) => {
        if (!mounted.current) return;
        setData({
          form: normalizeProfile(profileResult.profile, account?.email ?? ""),
          career: {
            education: normalizeEducationList(careerResult.education ?? []),
            experience: normalizeExperienceList(careerResult.experience ?? []),
            projects: normalizeProjectList(careerResult.projects ?? []),
            certifications: normalizeCertificationList(careerResult.certifications ?? []),
            awards: normalizeAwardList(careerResult.awards ?? []),
            publications: normalizePublicationList(careerResult.publications ?? [])
          }
        });
        setDirty(false);
      })
      .catch((cause: unknown) => {
        if (!mounted.current) return;
        setLoadError(cause instanceof Error ? cause.message : "Could not load your profile.");
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, [reloadToken]);

  const setForm = useCallback((update: (current: ProfileForm) => ProfileForm) => {
    setDirty(true);
    setSave({ status: "idle" });
    setData((current) => (current ? { ...current, form: update(current.form) } : current));
  }, []);

  const setCareer = useCallback((update: (current: CareerForm) => CareerForm) => {
    setDirty(true);
    setSave({ status: "idle" });
    setData((current) => (current ? { ...current, career: update(current.career) } : current));
  }, []);

  const saveProfile = useCallback(async () => {
    const current = dataRef.current;
    if (!current) return false;
    setSave({ status: "saving" });
    try {
      await api("/profile", {
        method: "PUT",
        body: JSON.stringify(profileToWire(current.form))
      });
      // The structured name has its own endpoint: PUT /profile is a full
      // overwrite that deliberately does not carry the name parts or the
      // confirmation flag. Saving here IS the user confirming the split, so it
      // is never re-derived from full_name afterwards.
      if (current.form.first_name.trim() && current.form.last_name.trim()) {
        await api("/profile/name", {
          method: "PUT",
          body: JSON.stringify({
            first_name: current.form.first_name.trim(),
            middle_name: current.form.middle_name.trim() || null,
            last_name: current.form.last_name.trim(),
            preferred_first_name: current.form.preferred_first_name.trim() || null,
            preferred_last_name: current.form.preferred_last_name.trim() || null
          })
        });
      }
      if (!mounted.current) return true;
      setSave({ status: "saved" });
      setDirty(false);
      return true;
    } catch (cause: unknown) {
      if (mounted.current) {
        setSave({
          status: "error",
          message: cause instanceof Error ? cause.message : "Could not save your changes."
        });
      }
      return false;
    }
  }, []);

  const saveCareer = useCallback(async () => {
    const current = dataRef.current;
    if (!current) return false;
    setSave({ status: "saving" });
    try {
      await api("/profile/career", {
        method: "PUT",
        body: JSON.stringify({
          education: current.career.education.map(cleanEducation),
          experience: current.career.experience.map(cleanExperience),
          projects: current.career.projects.map(cleanProject),
          certifications: current.career.certifications.map(cleanCertification),
          awards: current.career.awards.map(cleanAward),
          publications: current.career.publications.map(cleanPublication)
        })
      });
      if (!mounted.current) return true;
      setSave({ status: "saved" });
      setDirty(false);
      return true;
    } catch (cause: unknown) {
      if (mounted.current) {
        setSave({
          status: "error",
          message: cause instanceof Error ? cause.message : "Could not save your changes."
        });
      }
      return false;
    }
  }, []);

  // Setting the pending state here rather than inside the effect keeps the
  // effect free of synchronous state writes (and their cascading render).
  const reload = useCallback(() => {
    setLoading(true);
    setLoadError("");
    setSave({ status: "idle" });
    setReloadToken((token) => token + 1);
  }, []);

  return {
    data,
    loading,
    loadError,
    reload,
    save,
    resetSave: () => setSave({ status: "idle" }),
    setForm,
    setCareer,
    saveProfile,
    saveCareer,
    dirty,
    markPristine: () => setDirty(false)
  };
}

/** Shared with `emptyProfile` so a not-yet-loaded editor renders safely. */
export const emptyEditorData: ProfileEditorData = {
  form: emptyProfile,
  career: emptyCareer
};
