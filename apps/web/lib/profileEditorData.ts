"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
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
  profilePatchForSection,
  type ProfileForm,
  type ProfilePatchSection,
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
 * records as though the user had confirmed them. Main-profile focused editors
 * use PATCH, but still save explicitly so half-typed values are not persisted.
 *
 * So each section commits explicitly, and the status is only ever reported from
 * the server's response — never optimistically.
 *
 * Main-profile sections send only their owned fields. Career sections still
 * send the whole career document because that separate endpoint remains PUT.
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
  /** Server validation messages keyed by canonical profile field path. */
  fieldErrors: Record<string, string>;
  /** Clears a "saved"/"error" banner, e.g. when the user edits again. */
  resetSave: () => void;
  setForm: (update: (current: ProfileForm) => ProfileForm) => void;
  setCareer: (update: (current: CareerForm) => CareerForm) => void;
  /** Commits only the fields owned by one focused main-profile section. */
  saveProfileSection: (section: ProfilePatchSection) => Promise<boolean>;
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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const mounted = useRef(true);
  const saveInFlight = useRef(false);
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
    const current = dataRef.current;
    if (!current) return;
    const nextForm = update(current.form);
    const changed = Object.keys(nextForm).filter(
      (key) => !Object.is(nextForm[key as keyof ProfileForm], current.form[key as keyof ProfileForm])
    );
    const nextData = { ...current, form: nextForm };
    dataRef.current = nextData;
    setDirty(true);
    // Keep a failed save in Retry state while the user corrects its fields.
    // Saved/idle feedback resets normally on the next edit.
    setSave((currentSave) =>
      currentSave.status === "error" ? currentSave : { status: "idle" }
    );
    if (changed.length > 0) {
      setFieldErrors((errors) =>
        Object.fromEntries(
          Object.entries(errors).filter(
            ([path]) => !changed.some((field) => path === field || path.startsWith(`${field}.`))
          )
        )
      );
    }
    setData(nextData);
  }, []);

  const setCareer = useCallback((update: (current: CareerForm) => CareerForm) => {
    const current = dataRef.current;
    if (!current) return;
    const nextData = { ...current, career: update(current.career) };
    dataRef.current = nextData;
    setDirty(true);
    setSave({ status: "idle" });
    setData(nextData);
  }, []);

  const saveProfileSection = useCallback(async (section: ProfilePatchSection) => {
    const current = dataRef.current;
    if (!current || saveInFlight.current) return false;
    saveInFlight.current = true;
    setSave({ status: "saving" });
    setFieldErrors({});
    const payload = profilePatchForSection(current.form, section);
    try {
      let result = await patchProfile(payload);
      // The structured name has its own endpoint: PUT /profile is a full
      // document replacement and PATCH deliberately does not carry name parts.
      // Saving Personal details IS the user confirming the split.
      if (
        section === "personal" &&
        current.form.first_name.trim() &&
        current.form.last_name.trim()
      ) {
        result = await api<ProfileSaveResponse>("/profile/name", {
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
      if (result.profile) {
        const nextData = {
          ...current,
          form: normalizeProfile(result.profile, current.form.email)
        };
        dataRef.current = nextData;
        setData(nextData);
      }
      setFieldErrors({});
      setSave({ status: "saved" });
      setDirty(false);
      return true;
    } catch (cause: unknown) {
      if (mounted.current) {
        const ownedFields = new Set(Object.keys(payload));
        const errors =
          cause instanceof ApiError
            ? Object.fromEntries(
                Object.entries(cause.fieldErrors).filter(([path]) =>
                  ownedFields.has(path.split(".")[0])
                )
              )
            : {};
        setFieldErrors(errors);
        setSave({
          status: "error",
          message:
            Object.keys(errors).length > 0
              ? "Correct the highlighted fields and try again."
              : cause instanceof ApiError
                ? cause.formError ?? cause.message
                : cause instanceof Error
                  ? cause.message
                  : "Could not save your changes."
        });
      }
      return false;
    } finally {
      saveInFlight.current = false;
    }
  }, []);

  const saveCareer = useCallback(async () => {
    const current = dataRef.current;
    if (!current || saveInFlight.current) return false;
    saveInFlight.current = true;
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
    } finally {
      saveInFlight.current = false;
    }
  }, []);

  // Setting the pending state here rather than inside the effect keeps the
  // effect free of synchronous state writes (and their cascading render).
  const reload = useCallback(() => {
    setLoading(true);
    setLoadError("");
    setSave({ status: "idle" });
    setFieldErrors({});
    setReloadToken((token) => token + 1);
  }, []);

  return {
    data,
    loading,
    loadError,
    reload,
    save,
    fieldErrors,
    resetSave: () => setSave({ status: "idle" }),
    setForm,
    setCareer,
    saveProfileSection,
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

/** Dedicated partial-update client; it sends exactly the object it receives. */
type ProfileSaveResponse = { profile: ProfileWire | null };

export function patchProfile(payload: Record<string, unknown>): Promise<ProfileSaveResponse> {
  return api<ProfileSaveResponse>("/profile", { method: "PATCH", body: JSON.stringify(payload) });
}
