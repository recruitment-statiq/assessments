/**
 * Statiq Assessments — Folder Duplication Apps Script
 *
 * Called by the Cloudflare Worker when a candidate is granted access.
 * The Worker does NOT wait for this to finish (copying real files can take
 * a few minutes, longer than a web request is allowed to stay open).
 * Instead, when this script finishes, it writes the folder link straight
 * onto the candidate's Assessment_Access row in Notion.
 *
 * Deployed as a Web App: execute as recruitment@statiq.club, access "Anyone".
 *
 * Required Script Properties (Project Settings → Script Properties):
 *   NOTION_TOKEN       — the Statiq Assessments Worker Notion token
 *   SLACK_WEBHOOK_URL  — the Statiq Assessments Alerts webhook
 */
const TEMPLATE_FOLDER_ID = "1Ik08939Ce5WwHUZKExN-sRpbdlFqqGpw"; // master template, never modified
const PARENT_FOLDER_ID = "1hccXWVIBWjnLjDF7YcaLn2-08hOcbAaW";   // where duplicates are created

/**
 * Expects JSON body: { candidateName, candidateEmail, accessPageId }
 * accessPageId = the candidate's Assessment_Access row, so the link is
 * written to that exact row (not looked up by email).
 */
function doPost(e) {
  let body = {};
  try {
    body = JSON.parse(e.postData.contents);
    const candidateName = body.candidateName;
    const candidateEmail = body.candidateEmail;
    const accessPageId = body.accessPageId;

    if (!candidateName || !candidateEmail || !accessPageId) {
      throw new Error("candidateName, candidateEmail and accessPageId are required");
    }

    const templateFolder = DriveApp.getFolderById(TEMPLATE_FOLDER_ID);
    const parentFolder = DriveApp.getFolderById(PARENT_FOLDER_ID);

    const timestamp = Utilities.formatDate(new Date(), "GMT-3", "yyyy-MM-dd HH:mm");
    const newFolder = parentFolder.createFolder(
      candidateName + " — Client Manager Team Lead Assessment (" + timestamp + ")"
    );
    copyFolderContents(templateFolder, newFolder);
    newFolder.addEditor(candidateEmail);

    const folderUrl = newFolder.getUrl();
    writeFolderLinkToNotion(accessPageId, folderUrl);

    return jsonResponse({ folderUrl: folderUrl });

  } catch (err) {
    notifySlack(body.candidateName, body.candidateEmail, err.message);
    return jsonResponse({ error: err.message });
  }
}

/** Recursively copies all files and subfolders from source into target. */
function copyFolderContents(source, target) {
  const files = source.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    file.makeCopy(file.getName(), target);
  }
  const subfolders = source.getFolders();
  while (subfolders.hasNext()) {
    const subfolder = subfolders.next();
    copyFolderContents(subfolder, target.createFolder(subfolder.getName()));
  }
}

/** Writes the folder link onto the candidate's Assessment_Access row. */
function writeFolderLinkToNotion(accessPageId, folderUrl) {
  const token = PropertiesService.getScriptProperties().getProperty("NOTION_TOKEN");
  if (!token) throw new Error("NOTION_TOKEN script property is missing (folder was created: " + folderUrl + ")");

  const res = UrlFetchApp.fetch("https://api.notion.com/v1/pages/" + accessPageId, {
    method: "patch",
    contentType: "application/json",
    headers: {
      "Authorization": "Bearer " + token,
      "Notion-Version": "2022-06-28"
    },
    payload: JSON.stringify({
      properties: { "Working Folder Link": { url: folderUrl } }
    }),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() >= 300) {
    throw new Error("Folder was created (" + folderUrl + ") but writing it to Notion failed: " + res.getContentText());
  }
}

/** Slack alert — only sent when something genuinely fails. */
function notifySlack(candidateName, candidateEmail, errorMessage) {
  const webhook = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_URL");
  if (!webhook) return;
  try {
    UrlFetchApp.fetch(webhook, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        text: "⚠️ Folder duplication failed for *" + (candidateName || "unknown candidate") +
              "* (" + (candidateEmail || "no email") + "). Please create and share their working folder manually.\n\nError: " + errorMessage
      }),
      muteHttpExceptions: true
    });
  } catch (e) {
    // Nothing else we can do if the alert itself fails.
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Run manually once to confirm folder access + that both properties are set. */
function testAccess() {
  Logger.log("Template: " + DriveApp.getFolderById(TEMPLATE_FOLDER_ID).getName());
  Logger.log("Parent: " + DriveApp.getFolderById(PARENT_FOLDER_ID).getName());
  const props = PropertiesService.getScriptProperties();
  Logger.log("NOTION_TOKEN set: " + !!props.getProperty("NOTION_TOKEN"));
  Logger.log("SLACK_WEBHOOK_URL set: " + !!props.getProperty("SLACK_WEBHOOK_URL"));
}
