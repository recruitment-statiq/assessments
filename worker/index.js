// Statiq Assessments — Notion bridge Worker
//
// The browser app can never hold the Notion integration secret (it'd be
// visible to every candidate). This Worker holds it instead, and exposes
// only the narrow, specific endpoints the app actually needs.
//
// Required environment variable (set via `wrangler secret put`, never
// committed to this repo):
//   NOTION_TOKEN            — the integration's secret token
//
// Required environment variables (plain, can live in wrangler.toml):
//   ASSESSMENT_ACCESS_DB_ID
//   ASSESSMENT_ROLES_DB_ID
//   ASSESSMENT_SUBMISSIONS_DB_ID

const NOTION_VERSION = "2022-06-28";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*", // tighten to the real app domain once it's fixed
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

async function notionFetch(env, path, options = {}) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Notion API error (${res.status}): ${errText}`);
  }
  return res.json();
}

/**
 * POST /check-access
 * body: { email }
 * Looks up the email in Assessment_Access. Returns whether they're
 * allowed in, and if so, their name + assigned role — nothing about
 * any other candidate.
 */
async function handleCheckAccess(request, env) {
  const { email } = await request.json();
  if (!email) return json({ error: "email is required" }, 400);

  const result = await notionFetch(env, `databases/${env.ASSESSMENT_ACCESS_DB_ID}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: {
        property: "Email",
        email: { equals: email }
      }
    })
  });

  if (!result.results || result.results.length === 0) {
    return json({ allowed: false });
  }

  const page = result.results[0];
  const props = page.properties;

  return json({
    allowed: true,
    name: props["Candidate Name"]?.title?.[0]?.plain_text || "",
    role: props["Role"]?.select?.name || "",
    status: props["Status"]?.select?.name || "",
    accessPageId: page.id
  });
}

/**
 * POST /get-role-tasks
 * body: { role }
 * Fetches the ordered task list + instructions for a role from
 * Assessment_Roles. Instructions come from each task page's body,
 * not just its properties.
 */
async function handleGetRoleTasks(request, env) {
  const { role } = await request.json();
  if (!role) return json({ error: "role is required" }, 400);

  const result = await notionFetch(env, `databases/${env.ASSESSMENT_ROLES_DB_ID}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: {
        property: "Role",
        select: { equals: role }
      },
      sorts: [{ property: "Task Order", direction: "ascending" }]
    })
  });

  const tasks = [];
  for (const page of result.results || []) {
    const props = page.properties;
    const blocks = await notionFetch(env, `blocks/${page.id}/children`, { method: "GET" });
    const instructions = blocksToPlainText(blocks.results || []);

    tasks.push({
      name: props["Task Name"]?.title?.[0]?.plain_text || "",
      order: props["Task Order"]?.number ?? 0,
      type: props["Task Type"]?.select?.name || "",
      requiresSubmission: props["Requires Submission"]?.checkbox ?? true,
      templateFolderId: props["Template Folder ID"]?.rich_text?.[0]?.plain_text || null,
      instructions
    });
  }

  return json({ tasks });
}

function blocksToPlainText(blocks) {
  return blocks
    .map(b => {
      const type = b.type;
      const richText = b[type]?.rich_text || [];
      return richText.map(t => t.plain_text).join("");
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * POST /submit-assessment
 * body: { email, role, name, loggedInAt, startedAt, submittedAt, answers, workingFolderLink }
 * Creates the Assessment_Submissions page, then the caller (or a second
 * step here) is responsible for writing the link back to Recruiting_ROW.
 * Left as a stub — needs the real Recruiting_ROW database ID and property
 * names confirmed before this is wired end to end.
 */
async function handleSubmitAssessment(request, env) {
  const body = await request.json();
  const { email, role, name, loggedInAt, startedAt, submittedAt, answers, workingFolderLink } = body;

  if (!email || !role || !submittedAt) {
    return json({ error: "email, role, and submittedAt are required" }, 400);
  }

  const durationMinutes = startedAt && submittedAt
    ? Math.round((new Date(submittedAt) - new Date(startedAt)) / 60000)
    : null;

  const page = await notionFetch(env, "pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: env.ASSESSMENT_SUBMISSIONS_DB_ID },
      properties: {
        "Candidate Name": { title: [{ text: { content: name || email } }] },
        "Email": { email },
        "Role": { select: { name: role } },
        "Logged In At": loggedInAt ? { date: { start: loggedInAt } } : undefined,
        "Started At": startedAt ? { date: { start: startedAt } } : undefined,
        "Submitted At": { date: { start: submittedAt } },
        "Duration": { rich_text: [{ text: { content: durationMinutes != null ? `${durationMinutes} min` : "—" } }] },
        "Working Folder Link": workingFolderLink ? { url: workingFolderLink } : undefined,
        "Status": { select: { name: "Ready to Review" } }
      },
      children: answersToBlocks(answers)
    })
  });

  // TODO: write page.url back into Recruiting_ROW's Assessment column and
  // flip Assessment Review status, once that database ID + property names
  // are confirmed.

  return json({ submissionPageUrl: page.url, durationMinutes });
}

function answersToBlocks(answers = {}) {
  const blocks = [];
  for (const [taskName, text] of Object.entries(answers)) {
    if (!text) continue;
    blocks.push({
      object: "block",
      type: "heading_3",
      heading_3: { rich_text: [{ text: { content: taskName } }] }
    });
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ text: { content: text } }] }
    });
  }
  return blocks;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/check-access") {
        return await handleCheckAccess(request, env);
      }
      if (request.method === "POST" && url.pathname === "/get-role-tasks") {
        return await handleGetRoleTasks(request, env);
      }
      if (request.method === "POST" && url.pathname === "/submit-assessment") {
        return await handleSubmitAssessment(request, env);
      }
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }
};
