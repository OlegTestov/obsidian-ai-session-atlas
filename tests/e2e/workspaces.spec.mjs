import path from "node:path";
import { api, expect, ids, run, test, pickCardView } from "./fixtures.mjs";
/* global state -- the catalog page owns this binding */

const copy = {
  en: { all:"All sessions", manager:"Workspaces", manage:"Manage workspaces", edit:"Edit workspace",
    create:"Create", name:"Name", add:"New workspace", undo:"Undo", redo:"Redo", confirm:"Swap sessions", swap:"Swap these sessions?",
    resize:"Edit", released:"Unassigned", remove:"Return to Unassigned", removeBoard:"Delete workspace",
    deleteAsk:"Delete this workspace?", group:"Sessions to add", full:/is full/ },
  ru: { all:"Все сессии", manager:"Воркспейсы", manage:"Настроить воркспейсы", edit:"Настройка воркспейса",
    create:"Создать", name:"Название", add:"Новый воркспейс", undo:"Отменить", redo:"Повторить", confirm:"Поменять местами",
    swap:"Поменять сессии местами?", resize:"Настроить", released:"Без воркспейса", remove:"Вернуть в «Без воркспейса»",
    removeBoard:"Удалить воркспейс", deleteAsk:"Удалить воркспейс?", group:"Сессии для добавления", full:/нет места/ },
};

const action = (root, name) => root.getByRole("button", { name, exact:true });
const boardButton = (root, name) => action(root.locator("#workspace-tabs"), name);
const card = (root, id) => root.locator(`.workspace-grid .acard[data-id="${id}"]`);
const cell = (board, n) => board.locator(`[data-slot="${n}"]`);
const item = (root, id) => root.locator(`[data-ws-ref="${id}"]`);

async function create(root, t, name, size) {
  await action(root, t.add).click();
  const dialog = root.getByRole("dialog", {name:t.add,exact:true});
  await dialog.getByRole("textbox", {name:t.name}).fill(name);
  await action(dialog,size).click();
  await action(dialog,t.create).click();
  await expect(dialog).toBeHidden();
}

async function clean(page) {
  const frame = page.frames().find(one => one.url().includes("/?lang="));
  if (!frame) return;
  await frame.evaluate(async () => {
    const stored = await fetch("/api/workspaces").then(response => response.json());
    if (!stored.boards.length) return;
    await fetch("/api/workspaces", { method:"POST", headers:{"Content-Type":"application/json","X-Atlas-Token":window.ATLAS_TOKEN},
      body:JSON.stringify({revision:stored.revision,boards:[]}) });
  });
}

test.afterEach(async ({page}) => clean(page));

test("a long workspace strip scrolls without a visible scrollbar", async ({page,open,lang}) => {
  const boards = Array.from({length:12}, (_, index) => ({
    id:`workspace-${index}`, name:`Workspace ${index + 1}`, columns:1, rows:1, slots:[null],
  }));
  await page.route("**/api/workspaces", route => route.fulfill({json:{revision:1,boards}}));
  await page.setViewportSize({width:720,height:900});
  await open("active");
  const strip = page.locator("#workspace-tabs");
  await expect(strip.getByRole("button")).toHaveCount(boards.length + 1);
  expect(await strip.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await strip.evaluate(node => getComputedStyle(node).scrollbarWidth)).toBe("none");
  await strip.hover();
  await page.mouse.wheel(480,0);
  await expect.poll(() => strip.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
  const last = boardButton(page,boards.at(-1).name);
  await last.focus();
  await expect(last).toBeInViewport();
  await last.press("Enter");
  await expect(last).toHaveAttribute("aria-current","page");
  const shots = process.env.ATLAS_WORKSPACE_SHOTS;
  if (shots) await strip.screenshot({path:path.join(shots,`workspace-strip-${lang}.png`)});
});

test("the workspace tab menu asks before deleting and keeps its sessions", async ({page,open,lang}) => {
  const words = copy[lang];
  await open("active");
  await create(page,words,"To review","1 × 1");
  await page.evaluate(sid => window.saveWorkspaces(boards => {
    boards.find(board => board.name === "To review").slots[0] = sid;
  }), ids.claudeLive);
  const tab = boardButton(page,"To review");
  const menu = page.getByRole("menu", {name:"To review"});
  const remove = menu.getByRole("menuitem", {name:words.removeBoard});
  const confirm = page.getByRole("dialog", {name:words.deleteAsk});
  await tab.click({button:"right"});
  await expect(remove).toBeVisible();
  const shots = process.env.ATLAS_WORKSPACE_SHOTS;
  if (shots) await page.screenshot({path:path.join(shots,`workspace-menu-${lang}.png`)});
  const typography = node => {
    const {fontFamily,fontSize,fontWeight,fontStyle,lineHeight,letterSpacing} = getComputedStyle(node);
    return {fontFamily,fontSize,fontWeight,fontStyle,lineHeight,letterSpacing};
  };
  expect(await remove.evaluate(typography)).toEqual(await tab.evaluate(typography));
  const size = await remove.evaluate(button => {
    const label = document.createRange();
    label.selectNodeContents(button);
    const menuRect = button.parentElement.getBoundingClientRect();
    return {width:menuRect.width, height:menuRect.height, label:label.getBoundingClientRect().width};
  });
  expect(size.width).toBeLessThanOrEqual(size.label + 28);
  expect(size.height).toBeLessThanOrEqual(32);
  await remove.click();
  await expect(confirm).toContainText("To review");
  const cancel = confirm.getByRole("button", {name:lang === "ru" ? "Отмена" : "Cancel",exact:true});
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(confirm).toHaveCount(0);
  await expect(card(page,ids.claudeLive)).toBeVisible();

  await tab.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await tab.click({button:"right"});
  await remove.click();
  await action(confirm,words.removeBoard).click();
  await expect(tab).toHaveCount(0);
  await expect(boardButton(page,words.all)).toHaveAttribute("aria-current","page");
  await expect(page.locator(`#active-grid .acard[data-id="${ids.claudeLive}"]`)).toBeVisible();
});

test("long session titles and project lists fit their unassigned rows", async ({page,open,lang}) => {
  const snapshot = await api("/api/active");
  const sessions = Array.from({length:17}, (_, index) => ({
    ...snapshot.sessions[index % 2], session_id:`unassigned-${index}`,
    title:`Session ${index + 1} · Review the next milestone and confirm remaining decisions`,
    projects:Array.from({length:10}, (_, project) => `project-with-a-long-name-${project + 1}`),
  }));
  await page.route("**/api/active?*", route => route.fulfill({json:{...snapshot,sessions}}));
  await open("active");
  await action(page,copy[lang].manage).click();
  const pool = page.getByRole("region", {name:copy[lang].released});
  const list = pool.locator(".ws-unassigned");
  await expect(list.locator(".ws-item")).toHaveCount(sessions.length);
  const shots = process.env.ATLAS_WORKSPACE_SHOTS;
  for (const width of [1440,375]) {
    await page.setViewportSize({width,height:760});
    const fit = await list.locator(".ws-item").evaluateAll(rows => rows.every(row => {
      const bounds = row.getBoundingClientRect();
      return [...row.children].every(child => {
        const content = child.getBoundingClientRect();
        return content.top >= bounds.top && content.bottom <= bounds.bottom;
      });
    }));
    expect(fit,`unassigned rows at ${width}px`).toBe(true);
    if (shots) await pool.screenshot({path:path.join(shots,`unassigned-${lang}-${width}.png`)});
  }
  await list.hover();
  await page.mouse.wheel(0,480);
  await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
});

test("workspaces keep numbered slots through status changes, mode switches and reload", async ({page,open,lang,t}) => {
  const words = copy[lang];
  const snapshot = await api("/api/active");
  await page.route("**/api/active?*", route => route.fulfill({json:snapshot}));
  await open("active");
  await expect(boardButton(page,words.all)).toHaveAttribute("aria-current","page");
  await expect(page.locator("#active-grid .acard")).toHaveCount(2);
  await create(page,words,"Fixed slots","5 × 5");
  await expect(page.locator(".workspace-grid > .workspace-empty")).toHaveCount(25);
  await expect(page.locator(".lay-btn")).toHaveText("5×5");
  await page.locator('.workspace-grid [data-workspace-slot="24"] button').click();
  let manager = page.getByRole("dialog", {name:words.manager});
  let managedBoard = manager.getByRole("region", {name:"Fixed slots"});
  await expect(managedBoard.locator(".ws-position").last()).toHaveText("25");
  await item(manager,ids.codexLive).press("Enter");
  await expect(item(cell(managedBoard,24),ids.codexLive)).toBeVisible();
  await item(manager,ids.claudeLive).dragTo(cell(managedBoard,0));
  await expect(item(cell(managedBoard,0),ids.claudeLive)).toBeVisible();
  await item(managedBoard,ids.codexLive).click();
  await item(cell(managedBoard,0),ids.claudeLive).click();
  const swap = page.getByRole("dialog", {name:words.swap});
  await action(swap,words.confirm).click();
  await expect(item(cell(managedBoard,0),ids.codexLive)).toBeVisible();
  await action(manager,words.undo).click();
  await expect(item(cell(managedBoard,24),ids.codexLive)).toBeVisible();
  const redo = action(manager,words.redo);
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect(item(cell(managedBoard,0),ids.codexLive)).toBeVisible();
  await action(manager,words.undo).click();
  await expect(item(cell(managedBoard,24),ids.codexLive)).toBeVisible();
  await item(managedBoard,ids.codexLive).click();
  await action(manager,words.remove).click();
  await expect(item(manager.getByRole("region", {name:words.released}),ids.codexLive)).toBeVisible();
  await expect(redo).toBeDisabled();
  await action(manager,words.undo).click();
  await expect(item(cell(managedBoard,24),ids.codexLive)).toBeVisible();
  await manager.locator(".ws-close").click();

  await expect(card(page,ids.claudeLive)).toHaveAttribute("data-workspace-slot","0");
  await expect(card(page,ids.codexLive)).toHaveAttribute("data-workspace-slot","24");
  await card(page,ids.claudeLive).locator(".hidebtn").click();
  const hidden = page.locator('.workspace-grid [data-workspace-slot="0"]');
  await hidden.getByRole("button", {name: lang === "ru" ? "Показать скрытую сессию" : "Show hidden session"}).click();
  await expect(card(page,ids.claudeLive)).toHaveAttribute("data-workspace-slot","0");
  await page.locator('[data-mode="full"]').click();
  const picker = card(page,ids.claudeLive).locator(".card-view-picker");
  await pickCardView(card(page, ids.claudeLive), "files");
  for (const row of snapshot.sessions) row.activity = row.status = row.agent === "codex" ? "idle" : "busy";
  await page.evaluate(() => window.loadActive());
  await expect(card(page,ids.claudeLive)).toHaveClass(/\bbusy\b/);
  await expect(card(page,ids.codexLive)).toHaveAttribute("data-workspace-slot","24");
  await expect(page.locator("#active-grid .asec")).toHaveCount(0);
  await boardButton(page,words.all).click();
  await expect(page.locator("#active-grid .asec .acard")).toHaveCount(2);
  await boardButton(page,"Fixed slots").click();
  await expect(picker).toHaveAttribute("data-view", "files");
  await page.reload();
  await expect(boardButton(page,"Fixed slots")).toHaveAttribute("aria-current","page");
  await expect(card(page,ids.codexLive)).toHaveAttribute("data-workspace-slot","24");
  await expect(page.locator(".workspace-grid")).toHaveClass(/full c5 r5/);
  await boardButton(page,words.all).click();
  await expect(page.locator("#active-grid .asec .acard")).toHaveCount(2);
  await boardButton(page,"Fixed slots").click();

  await action(page,words.manage).click();
  await action(managedBoard,words.resize).click();
  const editor = page.getByRole("dialog", {name:words.edit});
  await action(editor,"1 × 1").click();
  await expect(editor.locator('[role="status"]')).toContainText("Reconcile the ledger");
  await action(editor,t.save).click();
  await expect(managedBoard.locator(".ws-slot")).toHaveCount(1);
  const pool = manager.getByRole("region", {name:words.released});
  await expect(item(pool,ids.codexLive)).toBeVisible();
  await item(managedBoard,ids.claudeLive).click();
  await action(manager,words.remove).click();
  await expect(item(pool,ids.claudeLive)).toBeVisible();
  await action(managedBoard,words.resize).click();
  await action(editor,words.removeBoard).click();
  await action(page.getByRole("dialog", {name:words.deleteAsk}),words.removeBoard).click();
  await expect(managedBoard).toHaveCount(0);
  await manager.locator(".ws-close").click();
  await expect(boardButton(page,words.all)).toHaveAttribute("aria-current","page");
});

test("a group uses its tab order and a new session fills only available workspace space", async ({page,lang}) => {
  const words = copy[lang];
  const snapshot = await api("/api/active");
  const restoring = "awaiting-restore";
  snapshot.recent_closed = [{session_id:restoring,title:"Restoring",last_activity_at:new Date().toISOString()}];
  const initial = snapshot.sessions.map((s,i) => ({ ...s, ancestors:[41000 + i] }));
  const tabs = initial.map((s,i) => ({ ptyPid:41000+i, agent:s.agent, title:s.title, inline:true,
    group:{id:"team",name:"My team",color:"blue",order:1-i} }));
  let current = initial;
  await page.route("**/api/active?*", route => route.fulfill({json:{ ...snapshot,sessions:current }}));
  await page.route(`${run.base}/workspace-host.html`, route => route.fulfill({contentType:"text/html",body:`<!doctype html>
    <script>
      const configured = ${JSON.stringify(tabs)};
      let launches = 0;
      window.addEventListener("message", e => {
        const d = e.data;
        const send = payload => e.source.postMessage({source:"session-atlas-host",...payload},location.origin);
        if (d.type === "list-tabs") send({type:"tabs",tabs:configured,groups:true,agents:{claude:true,codex:true},
          workspaceReservations:[${JSON.stringify(restoring)}]});
        if (d.type === "view-state") {
          window.savedAtlasHash = d.hash;
          window.atlasHashWrites = (window.atlasHashWrites || 0) + 1;
        }
        if (d.type === "new-session") {
          const instance = "codex-test-" + ++launches;
          configured.push({ptyPid:42000+launches,agent:"codex",title:d.title,inline:true,instance});
          send({type:"launch-result",request:d.launchRequest,ok:true,instance});
        }
      });
    </script><iframe src="/?lang=${lang}#view=active&wg=team"></iframe>`}));
  await page.goto(`${run.base}/workspace-host.html`);
  const frame = page.frameLocator("iframe");
  const editor = frame.getByRole("dialog", {name:words.add});
  await expect(editor.getByRole("textbox", {name:words.name})).toHaveValue("My team");
  await expect(editor.getByRole("group", {name:words.group}).locator("label")).toHaveText(initial.map(s => s.title).reverse());
  await action(editor,"3 × 1").click();
  await action(editor,words.create).click();
  await expect(card(frame,initial[1].session_id)).toHaveAttribute("data-workspace-slot","0");
  await expect(card(frame,initial[0].session_id)).toHaveAttribute("data-workspace-slot","1");

  const launch = async n => {
    await frame.locator(".newsess").click();
    await frame.locator("#ns-dir").fill(run.corpus.cwds.billing);
    await frame.locator("#ns-agent").selectOption("codex");
    await frame.locator("#ns-prompt").fill(`Workspace launch ${n}`);
    await frame.locator("#ns-go").click();
    await expect(frame.locator("#newsess")).toBeHidden();
    const session = {...initial.find(s => s.agent === "codex"),session_id:`workspace-session-${n}`,
      ancestors:[42000+n], title:`Workspace launch ${n}`};
    current = [...current,session];
    const loaded = page.frames().find(candidate => candidate.url().includes("/?lang="));
    await loaded.evaluate(() => window.loadActive());
    return session.session_id;
  };
  const third = await launch(1);
  await expect(card(frame,third)).toHaveAttribute("data-workspace-slot","2");
  const fourth = await launch(2);
  await expect(frame.locator("#workspace-notice")).toHaveText(words.full);
  await expect(card(frame,fourth)).toHaveCount(0);
  await boardButton(frame,words.all).click();
  await expect(frame.locator(`[data-id="${fourth}"]`).first()).toBeVisible();

  await create(frame,words,"Two launches","3 × 1");
  await frame.locator("body").evaluate(async (_, restoringId) => {
    await window.saveWorkspaces(boards => {
      boards.find(board => board.name === "Two launches").slots = [restoringId,"old-closed","atlas-tab:gone"];
    });
  }, restoring);
  const occupied = frame.locator('.workspace-grid [data-workspace-slot="0"]');
  await expect(occupied).toContainText(lang === "ru" ? "Ожидаем сессию…" : "Waiting for the session…");
  const layouts = /\/api\/workspaces$/;
  page.expectHttpError(layouts);
  let writeConflicts = 0;
  await page.route(layouts, route => {
    if (route.request().method() !== "POST" || writeConflicts) return route.fallback();
    writeConflicts++;
    return route.fulfill({status:409, json:{error:"The layout has changed."}});
  });
  const go = frame.locator("#ns-go");
  let pendingLaunches = 0;
  let releaseLaunch;
  const launchGate = new Promise(resolve => { releaseLaunch = resolve; });
  await page.route("**/api/new-session", async route => {
    pendingLaunches++;
    await launchGate;
    await route.continue();
  });
  const start = async agent => {
    await frame.locator(".newsess").click();
    await frame.locator("#ns-dir").fill(run.corpus.cwds.billing);
    await frame.locator("#ns-agent").selectOption(agent);
    const prepared = page.waitForResponse(response => response.url().endsWith("/api/new-session"));
    await go.click();
    if (agent === "claude") {
      try {
        await expect(go).toBeDisabled();
        await frame.locator("#ns-prompt").press("Control+Enter");
      } finally { releaseLaunch(); }
    }
    await expect(frame.locator("#newsess")).toBeHidden();
    return (await prepared).json();
  };
  const first = await start("claude");
  expect(pendingLaunches).toBe(1);
  expect(writeConflicts).toBe(1);
  await start("codex");
  const stored = await api("/api/workspaces");
  expect(stored.boards.find(board => board.name === "Two launches").slots)
    .toEqual([restoring,first.session_id,"atlas-tab:codex-test-4"]);
  const writes = await page.evaluate(() => window.atlasHashWrites);
  const loaded = page.frames().find(candidate => candidate.url().includes("/?lang="));
  await loaded.evaluate(() => {
    state.q = "sample search";
    state.current = "sample-session";
    window.writeHash();
  });
  await expect.poll(() => page.evaluate(() => window.atlasHashWrites)).toBeGreaterThan(writes);
  const saved = new URLSearchParams((await page.evaluate(() => window.savedAtlasHash)).slice(1));
  expect(saved.get("ws")).toBe(stored.boards.find(board => board.name === "Two launches").id);
  expect(saved.has("q")).toBe(false);
  expect(saved.has("s")).toBe(false);
});

test("workspace switching preserves reading position and cross-workspace attention is explicit", async ({page,open,lang}) => {
  const words = copy[lang];
  const snapshot = await api("/api/active");
  const codex = snapshot.sessions.find(session => session.session_id === ids.codexLive);
  const claude = snapshot.sessions.find(session => session.session_id === ids.claudeLive);
  snapshot.recent_closed = [{session_id:ids.claudeMain,title:"Earlier work",last_activity_at:new Date().toISOString()}];
  await page.route("**/api/active?*", route => route.fulfill({json:snapshot}));
  const turns = Array.from({length:20},(_, i) => ({id:`turn-${i}`,prompt:`Workspace prompt ${i}`,
    reply:(`A readable reply ${i}. `).repeat(32),steps:[]}));
  await page.route(`**/api/active/feed/${ids.codexLive}*`, route => route.fulfill({json:{turns}}));
  await open("active", "#am=full");
  await create(page,words,"Reading room","2 × 1");
  await create(page,words,"Other room","2 × 1");
  await action(page,words.manage).click();
  const manager = page.getByRole("dialog",{name:words.manager});
  const reading = manager.getByRole("region",{name:"Reading room"});
  const other = manager.getByRole("region",{name:"Other room"});
  await item(manager,ids.codexLive).click();
  await cell(reading,0).locator("button").click();
  await expect(item(reading,ids.codexLive)).toBeVisible();
  await item(manager,ids.claudeLive).click();
  await cell(other,0).locator("button").click();
  await expect(item(other,ids.claudeLive)).toBeVisible();
  const shots = process.env.ATLAS_WORKSPACE_SHOTS;
  if (shots) await manager.screenshot({path:path.join(shots,`workspace-manager-${lang}.png`)});
  await page.setViewportSize({width:320,height:740});
  expect(await manager.evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true);
  if (shots) await manager.screenshot({path:path.join(shots,`workspace-manager-narrow-${lang}.png`)});
  await page.setViewportSize({width:1440,height:900});
  await manager.locator(".ws-close").click();
  await boardButton(page,"Reading room").click();
  const feed = card(page,ids.codexLive).locator(".card-view-body");
  await expect(feed).toContainText("Workspace prompt 19");
  await feed.evaluate(node => { node.scrollTop = 150; });
  expect(await feed.evaluate(node => node.scrollTop)).toBe(150);
  await boardButton(page,"Other room").click();
  await expect(feed).toHaveCount(0);
  await boardButton(page,"Reading room").click();
  expect(await feed.evaluate(node => node.scrollTop)).toBe(150);

  claude.activity = claude.status = "waiting";
  codex.activity = codex.status = "idle";
  await page.evaluate(() => window.loadActive());
  await expect(page.locator("#workspace-attention")).toBeVisible();
  await expect(boardButton(page,"Reading room")).toHaveAttribute("aria-current","page");
  await page.locator("#workspace-attention").click();
  await action(page.locator("dialog.workspace-popup"),claude.title).click();
  await expect(boardButton(page,"Other room")).toHaveAttribute("aria-current","page");
  await expect(card(page,ids.claudeLive)).toHaveClass(/\bsel\b/);
  if (shots) await page.screenshot({path:path.join(shots,`workspace-active-${lang}.png`)});
  await page.locator("#workspace-history").click();
  await expect(page.locator("dialog.workspace-popup")).toContainText("Earlier work");
  await action(page.locator("dialog.workspace-popup"),lang === "ru" ? "Открыть в поиске" : "Open in search").click();
  await expect(page.locator("#view-search")).toHaveAttribute("aria-selected","true");
  await expect(page.locator("dialog.workspace-popup")).toHaveCount(0);
});
