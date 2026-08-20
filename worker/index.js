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

  // Write the submission link back into Recruiting_ROW and flip the
  // Assessment Review status, so the existing Slack notification pattern
  // picks it up. Matched by candidate email.
  try {
    await writeBackToRecruitingRow(env, email, page.url);
  } catch (err) {
    // The submission itself already succeeded and is safely in Notion —
    // don't fail the whole request if the write-back has an issue.
    // The candidate should never see an error for something on our side
    // that doesn't affect their own submission.
    return json({ submissionPageUrl: page.url, durationMinutes, writeBackWarning: err.message });
  }

  return json({ submissionPageUrl: page.url, durationMinutes });
}

/**
 * Finds the Recruiting_ROW page matching this candidate's email, writes
 * the submission link into its Assessment column, and flips Assessment
 * Review to "Ready to Review" — which is what the existing Slack
 * notification automation watches for.
 */
async function writeBackToRecruitingRow(env, email, submissionUrl) {
  const result = await notionFetch(env, `databases/${env.RECRUITING_ROW_DB_ID}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: {
        property: "Email",
        email: { equals: email }
      }
    })
  });

  if (!result.results || result.results.length === 0) {
    throw new Error(`No Recruiting_ROW page found for email ${email} — link was not written back.`);
  }

  // If more than one row matches (shouldn't normally happen), update the
  // most recently created one rather than guessing further.
  const targetPage = result.results[0];

  await notionFetch(env, `pages/${targetPage.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        "Assessment": { url: submissionUrl },
        "Assessment Review": { select: { name: "Ready to Review" } }
      }
    })
  });
}

function answersToBlocks(answers = {}) {
  const blocks = [];
  for (const [taskName, html] of Object.entries(answers)) {
    if (!html || !html.trim()) continue;
    blocks.push({
      object: "block",
      type: "heading_3",
      heading_3: { rich_text: [{ text: { content: taskName } }] }
    });
    blocks.push(...htmlToNotionBlocks(html));
  }
  return blocks;
}

/**
 * Converts the limited HTML our editor produces (p, strong, h3, ul/li)
 * into matching Notion blocks. This is intentionally narrow — the editor
 * never produces anything outside this set, so a full HTML parser isn't
 * needed. Falls back to a plain paragraph for any content that doesn't
 * match a recognized tag, so nothing is silently dropped.
 */
function htmlToNotionBlocks(html) {
  const blocks = [];
  // Split into top-level elements: <h3>...</h3>, <p>...</p>, <ul>...</ul>
  const topLevelPattern = /<(h3|p|ul)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  let matchedAny = false;

  while ((match = topLevelPattern.exec(html)) !== null) {
    matchedAny = true;
    const [, tag, inner] = match;

    if (tag.toLowerCase() === "h3") {
      blocks.push({
        object: "block",
        type: "heading_3",
        heading_3: { rich_text: htmlInlineToRichText(inner) }
      });
    } else if (tag.toLowerCase() === "ul") {
      const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let liMatch;
      while ((liMatch = liPattern.exec(inner)) !== null) {
        blocks.push({
          object: "block",
          type: "bulleted_list_item",
          bulleted_list_item: { rich_text: htmlInlineToRichText(liMatch[1]) }
        });
      }
    } else {
      // paragraph
      const richText = htmlInlineToRichText(inner);
      if (richText.length > 0) {
        blocks.push({
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: richText }
        });
      }
    }
  }

  // If nothing matched the expected tags (e.g. plain text typed with no
  // formatting, contenteditable sometimes omits wrapping <p> tags), fall
  // back to treating the whole thing as one paragraph.
  if (!matchedAny) {
    const richText = htmlInlineToRichText(html);
    if (richText.length > 0) {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: richText }
      });
    }
  }

  return blocks;
}

/**
 * Converts inline HTML (text possibly wrapped in <b>/<strong>) into
 * Notion rich_text segments, preserving bold formatting.
 */
function htmlInlineToRichText(inner) {
  const segments = [];
  const boldPattern = /<(b|strong)>([\s\S]*?)<\/\1>/gi;
  let lastIndex = 0;
  let match;

  while ((match = boldPattern.exec(inner)) !== null) {
    if (match.index > lastIndex) {
      const plain = stripTags(inner.slice(lastIndex, match.index));
      if (plain) segments.push({ text: { content: plain } });
    }
    const boldText = stripTags(match[2]);
    if (boldText) segments.push({ text: { content: boldText }, annotations: { bold: true } });
    lastIndex = boldPattern.lastIndex;
  }

  if (lastIndex < inner.length) {
    const plain = stripTags(inner.slice(lastIndex));
    if (plain) segments.push({ text: { content: plain } });
  }

  return segments;
}

function stripTags(str) {
  // Note: deliberately no .trim() here — trimming each inline segment
  // individually eats the space that should sit next to a bold word
  // (e.g. "the bold word" would lose its spaces around "bold" if we
  // trimmed the plain-text segments before/after it). Only collapse
  // literal HTML entities; leave whitespace exactly as typed.
  return str.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
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
