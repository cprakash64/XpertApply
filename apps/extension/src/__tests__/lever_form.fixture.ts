/**
 * A sanitized reproduction of jobs.lever.co's application form markup: each question is
 * an <li class="application-question"> whose <label> wraps BOTH the visible
 * `.application-label` text and the input; email and phone are plain type="text";
 * location is an autocomplete with a hidden selectedLocation; custom questions are
 * `cards[uuid][fieldN]`; pronouns are a checkbox group; EEO is a block of selects.
 */
export const LEVER_URL = "https://jobs.lever.co/zoox/11111111-2222-3333-4444-555555555555/apply";

const q = (label: string, required: boolean, field: string) =>
  `<li class="application-question"><label><div class="application-label">${label}${required ? '<span class="required">✱</span>' : ""}</div><div class="application-field">${field}</div></label></li>`;

export const LEVER_FORM = `<div class="application-page"><form id="application-form" method="POST" enctype="multipart/form-data"><ul>
${q("Resume/CV", true, '<input type="file" name="resume" id="resume-upload-input">')}
${q("Full name", true, '<input type="text" name="name" required>')}
<li class="application-question"><div class="application-label">Pronouns</div><div class="application-field"><ul data-qa="pronouns-list">
 <li><label><input type="checkbox" name="pronouns" value="She/her"><span class="application-answer-alternative">She/her</span></label></li>
 <li><label><input type="checkbox" name="pronouns" value="He/him"><span class="application-answer-alternative">He/him</span></label></li>
 <li><label><input type="checkbox" name="pronouns" value="They/them"><span class="application-answer-alternative">They/them</span></label></li>
 <li><label><input type="checkbox" name="pronouns" value="Prefer not to say"><span class="application-answer-alternative">Prefer not to say</span></label></li></ul></div></li>
${q("Email", true, '<input type="text" name="email" required>')}
${q("Phone", true, '<input type="text" name="phone" required>')}
${q("Current location", true, '<input type="text" name="location" id="location-input" autocomplete="off"><input type="hidden" name="selectedLocation" id="selected-location">')}
${q("Current company", false, '<input type="text" name="org">')}
${q("LinkedIn URL", false, '<input type="text" name="urls[LinkedIn]">')}
${q("GitHub URL", false, '<input type="text" name="urls[GitHub]">')}
${q("Preferred name", false, '<input type="text" name="cards[aaa][field0]">')}
${q("Will you now or in the future require sponsorship for employment visa status?", true,
  '<ul><li><label><input type="radio" name="cards[bbb][field0]" value="Yes" required><span>Yes</span></label></li><li><label><input type="radio" name="cards[bbb][field0]" value="No"><span>No</span></label></li></ul>')}
${q("Are you legally authorized to work in the United States?", true,
  '<ul><li><label><input type="radio" name="cards[ccc][field0]" value="Yes" required><span>Yes</span></label></li><li><label><input type="radio" name="cards[ccc][field0]" value="No"><span>No</span></label></li></ul>')}
${q("How did you hear about this job?", false, '<input type="text" name="cards[ddd][field0]">')}
${q("Additional information", false, '<textarea name="comments"></textarea>')}
</ul>
<div class="eeo"><h4>Voluntary self-identification</h4>
${q("Gender", false, '<select name="eeo[gender]"><option value="">Select ...</option><option>Male</option><option>Female</option><option>Decline to self-identify</option></select>')}
${q("Race", false, '<select name="eeo[race]"><option value="">Select ...</option><option>Asian</option><option>White</option><option>Decline to self-identify</option></select>')}
${q("Veteran status", false, '<select name="eeo[veteran]"><option value="">Select ...</option><option>I am not a protected veteran</option><option>Decline to self-identify</option></select>')}
</div>
<button class="template-btn-submit" type="submit">Submit application</button></form></div>`;
