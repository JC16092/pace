// Firebase project: your-project-id  ("Pace")
// These values are public by design — Firestore security rules are the real gate
// (see ../firestore.rules: only owner@example.com can read or write anything).
export const firebaseConfig = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "your-project-id.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project-id.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "1:YOUR_SENDER_ID:web:YOUR_APP_ID"
};

// The only account allowed in. Must match firestore.rules.
export const OWNER_EMAIL = "owner@example.com";
