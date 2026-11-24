# Instagram Reels autopost: one-time setup (D444, IP4)

Date: 2026-11-24. For: the streamer, no coding needed. Takes about 20 minutes, once.

Ujwalam posts each clip that goes to YouTube Shorts as an Instagram Reel too. Instagram only allows this
through a free "Meta app" that you own. These steps make that app and connect it to Ujwalam.

> Meta changes its screens often. Names marked UNVERIFIED were not checked against Meta's site on
> 2026-11-24. If a button has a slightly different name, pick the one that means the same thing.

## What you need

- Your Instagram account and the Facebook account that manages it.
- Ujwalam open on this PC.

## Steps

1. **Make your Instagram account a professional account.** In the Instagram app: Settings > Account type
   and tools > Switch to professional account (UNVERIFIED). Pick Creator or Business. Both work.
2. **Link a Facebook Page to it.** In the Instagram app: Edit profile > Page (UNVERIFIED), then pick or make
   a Facebook Page. Ujwalam finds your Instagram account through this Page. Without it, Connect says
   "No Instagram professional account".
3. **Open the Meta developer site.** Go to developers.facebook.com and sign in with your Facebook account.
   If asked, register as a developer (free).
4. **Create the app.** Click My Apps > Create app (UNVERIFIED). When it asks what the app is for, pick the
   use case for managing Instagram content or "Other", then the app type **Business** (UNVERIFIED). Give it
   any name. It is private to you.
5. **Add Instagram and Facebook Login.** In the app's dashboard, add the product **Instagram** (the
   "API setup with Facebook login" option, UNVERIFIED) and the product **Facebook Login**.
6. **Add the four permissions.** In the app's permissions list (App Review > Permissions and features,
   UNVERIFIED), make sure these four are added:
   - `instagram_basic`
   - `instagram_content_publish`
   - `pages_show_list`
   - `pages_read_engagement`
7. **Add yourself as a tester of your own app.** In App roles > Roles (UNVERIFIED), make sure your own
   Facebook account is listed (as Administrator or Tester). The app stays in **Development** mode. In this
   mode Meta lets the app's own people use these permissions without an app review (UNVERIFIED until the
   first real post).
8. **Paste the redirect address.** In Ujwalam open Settings > Posting & growth > INSTAGRAM REELS. The card
   shows a line: "In your Meta app (Facebook Login > Settings > Valid OAuth Redirect URIs) add exactly: ...".
   Copy that address (it looks like `http://localhost:<number>/`). In your Meta app go to Facebook Login >
   Settings and paste it into **Valid OAuth Redirect URIs**. Click Save changes.
9. **Copy the App ID and App Secret.** In your Meta app go to App settings > Basic (UNVERIFIED). Copy the
   **App ID**. Click Show next to **App Secret** and copy it too.
10. **Put them into Ujwalam.** On the INSTAGRAM REELS card, paste them into the **App ID** and **App Secret**
    boxes and click **Save app**. They are stored in Windows Credential Manager only and never shown again.
11. **Click Connect.** Your browser opens a Facebook sign-in page. Sign in and allow the Page and Instagram
    account. When the browser says you can close it, go back to Ujwalam. The card now shows your connected
    account.
12. **Turn it on.** Make sure the switch reads **Instagram Reels autopost on**.

## After setup

- Each Shorts clip gets an Instagram line in the Posts window: waiting (with its time), posting, posted,
  failed (with the reason in plain words) or dropped.
- Posts never go out while you are live. They keep the same gap as the auto-post schedule.
- The sign-in lasts about 60 days and Ujwalam renews it on its own. If the card says to connect again,
  click **Connect again**.
- **Drop Instagram queue** stops every Instagram post that has not gone out yet. Posted Reels stay.
- **Disconnect** removes the saved sign-in from this PC. Nothing more is posted until you connect again.
- A clip file is only deleted after YouTube and Instagram both posted it (or Instagram was dropped).

## If something goes wrong

- "No Instagram professional account": do steps 1 and 2, then click Connect again.
- The browser shows a redirect error: the address from step 8 is missing or different. Paste it exactly.
- "Instagram is not connected (or the sign-in expired)": click Connect again.
