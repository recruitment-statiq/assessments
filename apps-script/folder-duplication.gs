/**
 * Statiq Assessments — Folder Duplication Apps Script
 *
 * Deploy this as a Web App (Deploy > New deployment > Web app), executing
 * as "Me" (recruitment@statiq.club — the account that owns/has editor
 * access to the template folder), accessible to "Anyone" so the
 * Cloudflare Worker can call it.
 *
 * After deploying, copy the Web App URL into the Worker's
 * APPS_SCRIPT_URL environment variable.
 *
 * WHERE THINGS LIVE (fill these in before deploying):
 */
const TEMPLATE_FOLDER_ID = "1Ik08939Ce5WwHUZKExN-sRpbdlFqqGpw"; // the master template, never modified
const PARENT_FOLDER_ID = "1hccXWVIBWjnLjDF7YcaLn2-08hOcbAaW";   // where duplicates get created, alongside the template

/**
 * Entry point for POST requests from the Worker.
 * Expects JSON body: { candidateName, candidateEmail }
 * Returns JSON: { folderUrl } on success, or { error } on failure.
 */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const candidateName = body.candidateName;
    const candidateEmail = body.candidateEmail;

    if (!candidateName || !candidateEmail) {
      return jsonResponse({ error: "candidateName and candidateEmail are required" });
    }

    const templateFolder = DriveApp.getFolderById(TEMPLATE_FOLDER_ID);
    const parentFolder = DriveApp.getFolderById(PARENT_FOLDER_ID);

    // Name the duplicate clearly so it's identifiable at a glance in Drive,
    // and won't collide if the same candidate is somehow duplicated twice.
    const timestamp = Utilities.formatDate(new Date(), "GMT-3", "yyyy-MM-dd HH:mm");
    const newFolderName = `${candidateName} — Client Manager Team Lead Assessment (${timestamp})`;

    const newFolder = parentFolder.createFolder(newFolderName);
    copyFolderContents(templateFolder, newFolder);

    // Grant the candidate edit access so they can actually work in it.
    newFolder.addEditor(candidateEmail);

    return jsonResponse({ folderUrl: newFolder.getUrl() });

  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

/**
 * Recursively copies all files and subfolders from source into target.
 * Standard DriveApp pattern — there's no built-in "copy folder" method,
 * so files and subfolders are each copied/created individually.
 */
function copyFolderContents(source, target) {
  const files = source.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    file.makeCopy(file.getName(), target);
  }

  const subfolders = source.getFolders();
  while (subfolders.hasNext()) {
    const subfolder = subfolders.next();
    const newSubfolder = target.createFolder(subfolder.getName());
    copyFolderContents(subfolder, newSubfolder);
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Run this once manually from the Apps Script editor (not via the web
 * app) to confirm TEMPLATE_FOLDER_ID and PARENT_FOLDER_ID are both
 * accessible before wiring this up to the real app.
 */
function testAccess() {
  const templateFolder = DriveApp.getFolderById(TEMPLATE_FOLDER_ID);
  const parentFolder = DriveApp.getFolderById(PARENT_FOLDER_ID);
  Logger.log("Template folder name: " + templateFolder.getName());
  Logger.log("Parent folder name: " + parentFolder.getName());
  Logger.log("Access confirmed for both folders.");
}
