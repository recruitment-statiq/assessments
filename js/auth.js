// Statiq Assessments — Auth flow
//
// Handles: sending the magic link, completing sign-in when the candidate
// clicks it, and checking the candidate's email against Assessment_Access
// (via the Cloudflare Worker — the browser never talks to Notion directly).

import {
  auth,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  onAuthStateChanged,
  signOut,
  ACTION_CODE_SETTINGS
} from "./firebase-config.js";

// TODO: replace with the real deployed Worker URL once it exists.
const WORKER_BASE_URL = "https://statiq-assessments-worker.recruitment-552.workers.dev";

const STORAGE_KEY_EMAIL = "statiq_assessments_pending_email";

/**
 * Step 1: candidate enters their email, we send them a magic link.
 * We store the email locally so that if they open the link on the same
 * device, we don't have to ask them to re-type it.
 */
export async function requestSignInLink(email) {
  const normalized = email.trim().toLowerCase();
  await sendSignInLinkToEmail(auth, normalized, ACTION_CODE_SETTINGS);
  window.localStorage.setItem(STORAGE_KEY_EMAIL, normalized);
}

/**
 * Step 2: candidate clicks the link, lands back on the app. If the URL
 * matches Firebase's sign-in-link pattern, complete the sign-in.
 * Returns the signed-in user, or null if this page load isn't a
 * sign-in-link completion.
 */
export async function completeSignInIfApplicable() {
  if (!isSignInWithEmailLink(auth, window.location.href)) {
    return null;
  }

  let email = window.localStorage.getItem(STORAGE_KEY_EMAIL);
  if (!email) {
    // Candidate opened the link on a different device than they
    // requested it from — ask them to confirm their email again.
    email = window.prompt("Please confirm the email address you used to request this link:");
  }

  const result = await signInWithEmailLink(auth, email, window.location.href);
  window.localStorage.removeItem(STORAGE_KEY_EMAIL);

  // Clean the sign-in params out of the URL so a refresh doesn't
  // attempt to "complete" sign-in again.
  window.history.replaceState({}, document.title, window.location.pathname);

  return result.user;
}

/**
 * Checks Assessment_Access (via the Worker) for this email.
 * Returns { allowed: boolean, role?: string, name?: string } —
 * never exposes anything about other candidates.
 */
export async function checkAssessmentAccess(email) {
  const res = await fetch(`${WORKER_BASE_URL}/check-access`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.trim().toLowerCase() })
  });

  if (!res.ok) {
    throw new Error("Could not verify access right now. Please try again.");
  }

  return res.json();
}

export function watchAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function logOut() {
  await signOut(auth);
}
