# Building the iOS App for the App Store

This app has already been "wrapped" for iOS using a tool called Capacitor — the native
Xcode project is included in the `ios/` folder. You do **not** need to build anything
from scratch. You just need a Mac to open it, sign it, and upload it.

## Before you start — one prerequisite

This app is not a static site — it has a live database, login, email, and Xero
integration. The iOS app is configured to load the **real deployed website**, not a
local copy. That means **the web app must already be deployed somewhere public**
(e.g. Railway, Render) with a real `https://` address before this build is useful.

If that's not done yet, stop here and get the web app deployed first — the person
doing this Mac build will need that URL.

## What you need before starting

- A Mac (any reasonably recent one running macOS)
- **Xcode** installed (free, via the Mac App Store — it's a large download, ~15GB, budget time for this)
- **Node.js** installed (v20 recommended) — https://nodejs.org
- An **Apple Developer Program** membership ($99/year) — the account owner needs to
  enroll at https://developer.apple.com/programs/ before you can submit (this can be
  the business owner's own Apple ID, doesn't have to be yours)

## Step 1 — Get the project onto the Mac

Copy the entire project folder (this whole `boatology` folder) onto the Mac —
via AirDrop, a shared drive, USB, or however is easiest.

## Step 2 — Set the real deployed URL

Open `capacitor.config.ts` in a text editor and replace this line:

```ts
url: 'https://YOUR_DEPLOYED_URL_HERE',
```

with the actual deployed URL, e.g.:

```ts
url: 'https://boatology.up.railway.app',
```

## Step 3 — Install dependencies and rebuild

Open Terminal, navigate into the project folder, then run:

```bash
npm install
npm run build
npx cap sync ios
```

This copies your latest config into the native iOS project.

## Step 4 — Open the project in Xcode

```bash
npx cap open ios
```

This opens `ios/App/App.xcworkspace` in Xcode directly (open this exact file —
**not** `App.xcodeproj` — if Xcode asks).

## Step 5 — Set up signing

1. In Xcode's left sidebar, click on the **App** project (top item)
2. Select the **App** target, then the **Signing & Capabilities** tab
3. Under **Team**, choose the Apple Developer account (sign in with the Apple ID
   if it's not listed yet — Xcode → Settings → Accounts)
4. Xcode will auto-generate a signing certificate and provisioning profile —
   if you see red errors here, it usually means the Apple Developer Program
   enrollment ($99/year) hasn't finished processing yet

## Step 6 — Set your app icon and details

The app icon is already included (Assets.xcassets → AppIcon) — no action needed
unless you want to change it. Confirm in `Info.plist` that:
- **Display Name** is correct ("Boatology" by default)
- **Bundle Identifier** matches what you'll register in App Store Connect
  (currently `com.boatologymarine.app` — change this in `capacitor.config.ts`
  and re-run `npx cap sync ios` if you want something different)

## Step 7 — Test on a real device or simulator first

Plug in an iPhone (or use the simulator), select it as the run target at the top
of Xcode, and click the **Play** button. Confirm login and core pages actually work
before submitting — this is the point to catch any issues.

## Step 8 — Create the app listing in App Store Connect

Before uploading, go to https://appstoreconnect.apple.com and:
1. Click **My Apps** → **+** → **New App**
2. Fill in the name, primary language, bundle ID (must match Xcode), and SKU
3. You'll need:
   - App description, keywords, support URL
   - A **Privacy Policy URL** (required — must be a real, live webpage)
   - Screenshots (Xcode's simulator can generate these — required sizes are listed
     in App Store Connect)
   - A content rating questionnaire

## Step 9 — Archive and upload

1. In Xcode, set the build target device to **Any iOS Device (arm64)** (top bar, next
   to the Play button)
2. Menu bar → **Product → Archive** (this takes a few minutes)
3. Once archiving finishes, the **Organizer** window opens automatically
4. Select the archive → click **Distribute App** → **App Store Connect** → **Upload**
5. Follow the prompts (Xcode handles signing automatically at this step)

## Step 10 — Submit for review

1. Back in App Store Connect, go to your app → the build you just uploaded should
   appear within 15-30 minutes (sometimes up to a couple hours)
2. Attach that build to your app version, fill in remaining metadata, and click
   **Submit for Review**
3. Apple typically responds in 24-72 hours. If rejected, they'll explain why —
   common first-round issues are missing privacy policy details or unclear
   account deletion instructions (required since the app has user accounts)

## After approval

Once live, updates follow the same flow: bump the version number in Xcode,
archive, upload, submit — no need to redo the signing/listing setup.
