// Statiq Assessments — Firebase configuration
//
// This config is safe to be public (it's client-side by design — Firebase
// security comes from Firestore rules and auth checks, not from hiding
// this object). See firestore.rules for the actual access control.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getAuth,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAtkCQTAE0-zL9fIyb8lmwP2GSxdqqhu1s",
  authDomain: "statiq-assessments.firebaseapp.com",
  databaseURL: "https://statiq-assessments-default-rtdb.firebaseio.com",
  projectId: "statiq-assessments",
  storageBucket: "statiq-assessments.firebasestorage.app",
  messagingSenderId: "530279739154",
  appId: "1:530279739154:web:6d49d249f65bd1a3f88dcb"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export {
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  onAuthStateChanged,
  signOut,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp
};

// Where the magic link sends candidates back to. This must exactly match
// a domain listed in Firebase Auth > Settings > Authorized domains.
// While developing locally or via GitHub Pages preview, update this to
// match whatever URL is actually serving the app.
export const ACTION_CODE_SETTINGS = {
  url: window.location.origin + window.location.pathname,
  handleCodeInApp: true
};
