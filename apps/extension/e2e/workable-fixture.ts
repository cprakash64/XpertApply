/**
 * An OWNED fixture shaped like the public Workable application page (apply.workable.com/<company>/j/<SHORTCODE>/apply/), built from a
 * read-only inspection of a public posting (no input, no submit): one `form[data-ui="application-form"]` that a client script renders after
 * load; sections "Personal information" and "Profile"; inputs `firstname`, `lastname`, `email` (type=email, `aria-labelledby` labels that
 * carry a leading "*"), `phone` (name=phone, id=input_phone, a country button beside it); a resume dropzone whose real `input[type=file]`
 * (data-ui="resume", accept=".pdf,.doc,.docx,.odt,.rtf") sits visually hidden behind a "Choose file" label; a submit button with
 * data-ui="apply-button". Optional cover-letter dropzone and screening questions are modelled on other postings' forms.
 *
 * It contains no real employer content, no real person's data and no external resources. It is a fixture, not Workable.
 */
export interface WorkableOptions {
  title?: string;
  coverLetter?: boolean;
  questions?: boolean;
  /** Milliseconds before the client script renders the form (the real page is a single-page app). */
  renderDelayMs?: number;
  /** A field with no upload control at all (the "not applicable" case). */
  noResumeField?: boolean;
  /** The dropzone accepts the file silently: no file name is ever shown (the employer component did not take it). */
  silentUpload?: boolean;
}

export function workableApplication(options: WorkableOptions = {}): string {
  const title = options.title ?? "Software Engineer";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} - Acme Co - Application</title>
<style>.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}[role=alert]{color:#b00020;font-size:13px}.chip{border:1px solid #ccc;padding:2px 6px;border-radius:4px}</style></head>
<body><div id="root"></div>
<div id="cookie" role="dialog" aria-label="Cookies"><button type="submit" data-ui="cookie-consent-accept">Accept</button><button type="submit" data-ui="cookie-consent-decline">Decline</button></div>
<script>
window.__emp = { submits: 0, clicks: 0, events: [] };
const OPT = ${JSON.stringify({ cover: !!options.coverLetter, questions: !!options.questions, noResume: !!options.noResumeField, silent: !!options.silentUpload, title })};
const rid = () => Math.random().toString(36).slice(2, 18);
function field(id, label, extra) {
  return '<div data-role="field"><span id="' + id + '_label"><strong>*</strong>' + label + '</span>' +
    '<div data-role="illustrated-input"><div><input id="' + id + '" name="' + id + '" data-ui="' + id + '" aria-labelledby="' + id + '_label" aria-required="true" required maxlength="255" dir="auto" ' + (extra || 'type="text"') + ' value=""></div></div>' +
    '<span role="alert" data-for="' + id + '" hidden></span></div>';
}
function dropzone(kind, label, required) {
  const key = rid();
  return '<div data-role="field-group"><span><strong>' + (required ? '*' : '') + '</strong><span id="' + key + '_label"><strong>' + label + '</strong></span></span>' +
    '<div data-role="dropzone"><div data-role="preview"><label for="input_files_input_' + key + '"></label></div><div>' +
    '<label tabindex="0" role="button" for="input_files_input_' + key + '" id="description_input_' + key + '">Choose file</label> <span>or drag and drop here</span></div>' +
    '<div data-role="file-chips" data-for="' + kind + '"></div>' +
    '<input data-ui="' + kind + '" tabindex="-1" class="vh" id="input_files_input_' + key + '" type="file" aria-labelledby="' + key + '_label description_input_' + key + '"' +
    ' accept=".pdf,.doc,.docx,.odt,.rtf,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.oasis.opendocument.text,application/rtf"' + (required ? ' required' : '') + '></div>' +
    '<span role="alert" data-for="' + kind + '" hidden></span></div>';
}
function render() {
  const qs = OPT.questions ? '<section data-ui="section"><h2>Questions</h2><div data-ui="section-fields">' +
      '<div data-role="field"><span id="QA_1_label"><strong>*</strong>How many years of Python experience do you have?</span><textarea id="QA_1" name="QA_1" aria-labelledby="QA_1_label" required></textarea></div>' +
      '<fieldset data-role="field"><legend><strong>*</strong>Are you legally authorized to work in the country where this job is located?</legend>' +
      '<label><input type="radio" name="QA_2" value="yes" required> Yes</label> <label><input type="radio" name="QA_2" value="no"> No</label></fieldset>' +
    '</div></section>' : '';
  document.getElementById("root").innerHTML = '<h1>' + OPT.title + '</h1>' +
    '<form data-ui="application-form" novalidate>' +
    '<section data-ui="section"><h2>Personal information</h2><a data-ui="clear-section-0" href="#">Clear</a><div data-ui="section-fields">' +
      field("firstname", "First name") + field("lastname", "Last name") + field("email", "Email", 'type="email"') +
      '<div data-role="field"><span id="phone_label"><strong>*</strong>Phone</span><button type="button" aria-label="Change country for phone number, current">US</button>' +
      '<input id="input_phone" name="phone" type="tel" autocomplete="tel" required aria-labelledby="phone_label" value=""><span role="alert" data-for="phone" hidden></span></div>' +
    '</div></section>' +
    '<section data-ui="section"><h2>Profile</h2><a data-ui="clear-section-1" href="#">Clear</a><div data-ui="section-fields">' +
      (OPT.noResume ? '' : dropzone("resume", "Resume", true)) + (OPT.cover ? dropzone("cover_letter", "Cover letter", false) : '') +
    '</div></section>' + qs +
    '<button type="submit" data-ui="apply-button">Submit application</button></form>';
  wire();
}
function validate(input) {
  const out = document.querySelector('[data-for="' + (input.id === "input_phone" ? "phone" : input.id) + '"]');
  if (!out) return;
  let msg = "";
  if (input.required && !input.value) msg = "This field is required";
  else if (input.type === "email" && !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(input.value)) msg = "Invalid email";
  out.hidden = !msg; out.textContent = msg;
}
function wire() {
  const form = document.querySelector('form[data-ui="application-form"]');
  // Controlled inputs: the component keeps its own state and re-renders the field from it; only genuine input events update it.
  const state = {};
  form.addEventListener("input", (e) => { const t = e.target; if (t.matches('input[type=text],input[type=email],input[type=tel],textarea')) { state[t.id || t.name] = t.value; window.__emp.events.push(t.id || t.name); } });
  form.addEventListener("blur", (e) => { if (e.target.matches('input,textarea')) validate(e.target); }, true);
  form.addEventListener("change", (e) => {
    const t = e.target;
    if (t.type === "file") {
      const kind = t.getAttribute("data-ui"); const f = t.files && t.files[0];
      const chips = form.querySelector('[data-role=file-chips][data-for="' + kind + '"]'); const out = form.querySelector('[role=alert][data-for="' + kind + '"]');
      chips.textContent = ""; out.hidden = true;
      if (!f) return;
      if (OPT.silent) return;
      if (!/\\.(pdf|doc|docx|odt|rtf)$/i.test(f.name)) { out.hidden = false; out.textContent = "Unsupported file type"; return; }
      const chip = document.createElement("span"); chip.className = "chip"; chip.setAttribute("data-role", "file-name"); chip.textContent = f.name; chips.appendChild(chip);
      window.__emp.events.push("file:" + kind);
    }
  });
  form.addEventListener("click", (e) => { if (e.target.closest && e.target.closest('[data-ui="apply-button"]')) window.__emp.clicks++; }, true);
  form.addEventListener("submit", (e) => { e.preventDefault(); window.__emp.submits++; });
}
setTimeout(render, ${options.renderDelayMs ?? 600});
</script></body></html>`;
}
