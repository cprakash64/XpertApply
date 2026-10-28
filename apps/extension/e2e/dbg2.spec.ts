import { test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(here, "bundle", "harness.js");
test("dbg city", async ({ page }) => {
  await page.goto("about:blank");
  await page.setContent(`<main id="app"></main>`);
  await page.evaluate(() => {
    class SplInput extends HTMLElement { connectedCallback(){ if(this.shadowRoot) return; const root=this.attachShadow({mode:"open"}); const id=this.getAttribute("input-id")??"x"; const label=document.createElement("label"); label.setAttribute("for",id); label.textContent=this.getAttribute("label")??""; const input=document.createElement("input"); input.id=id; input.type="text"; if(this.hasAttribute("required")) input.setAttribute("aria-required","true"); for(const n of ["role","aria-autocomplete","aria-controls"]){const v=this.getAttribute(n); if(v) input.setAttribute(n,v);} input.addEventListener("input",()=>this.setAttribute("value",input.value)); root.append(label,input);} }
    customElements.define("spl-input", SplInput);
    class SplAutocomplete extends HTMLElement { connectedCallback(){ if(this.shadowRoot) return; const root=this.attachShadow({mode:"open"}); const label=this.getAttribute("label")??""; const mode=this.getAttribute("mode")??"both"; const id="ac-city"; const menuId="menu-"+id;
      const inner=document.createElement("spl-input"); inner.setAttribute("label",label); inner.setAttribute("input-id",id); inner.setAttribute("role","combobox"); inner.setAttribute("aria-autocomplete",mode); inner.setAttribute("aria-controls",menuId); inner.setAttribute("required","");
      const menu=document.createElement("div"); menu.id=menuId; menu.setAttribute("role","listbox"); menu.style.display="none"; root.append(inner,menu);
      const suggestions=JSON.parse(this.getAttribute("suggestions")??"[]");
      const input=inner.shadowRoot.querySelector("input");
      input.addEventListener("input",()=>{ const q=input.value.trim().toLowerCase(); menu.innerHTML=""; if(q.length<3){menu.style.display="none";input.setAttribute("aria-expanded","false");return;} const hits=suggestions.filter(s=>s.toLowerCase().includes(q)); for(const item of hits){ const o=document.createElement("spl-select-option"); o.setAttribute("value",item); o.textContent=item; o.addEventListener("click",()=>{input.value=item;this.setAttribute("value",item);menu.style.display="none";input.setAttribute("aria-expanded","false");input.dispatchEvent(new Event("change",{bubbles:true,composed:true}));}); menu.appendChild(o);} menu.style.display=hits.length?"block":"none"; input.setAttribute("aria-expanded",hits.length?"true":"false"); });
    } }
    customElements.define("spl-autocomplete", SplAutocomplete);
    const city=document.createElement("spl-autocomplete");
    city.setAttribute("label","City"); city.setAttribute("mode","list"); city.setAttribute("required","");
    city.setAttribute("suggestions", JSON.stringify(["Phoenix, AZ, US","Phoenix, OR, US","Phoenix, NY, US","Phoenix, IL, US"]));
    document.getElementById("app").appendChild(city);
  });
  await page.addScriptTag({ path: HARNESS });
  const found = await page.evaluate(() => (window as any).JobPilotHarness.discover("#app"));
  console.log("DISCOVERED", JSON.stringify(found));
  console.log("CUSTOM", JSON.stringify(await page.evaluate(() => {
    const roots=(r:any,acc:any[]=[r]):any[]=>{const n:any[]=[];for(const e of r.querySelectorAll("*")){if(e.shadowRoot){acc.push(e.shadowRoot);n.push(e.shadowRoot)}}for(const x of n)roots(x,acc);return acc};
    const sel='[role="combobox"],[role="listbox"],[aria-haspopup="listbox"],[class*="-control"],[class*="__control"]';
    const out:any[]=[];for(const rt of roots(document.getElementById("app"))){for(const e of rt.querySelectorAll(sel))out.push({tag:e.tagName,id:(e as any).id,role:e.getAttribute("role"),ac:e.getAttribute("aria-autocomplete"),req:e.getAttribute("aria-required"),hasInnerInput:!!(e as any).shadowRoot?.querySelector?.("input")})}
    return out;
  })));
  const r = await page.evaluate(() => (window as any).JobPilotHarness.fill("City", "Phoenix, Arizona, United States"));
  console.log("FILL", JSON.stringify(r));
  console.log("EVENTS", JSON.stringify(await page.evaluate(() => (window as any).JobPilotHarness.events())));
});
