# tutorial-recorder

Record captioned how-to videos of a web app by scripting a browser with [Playwright](https://playwright.dev). Each video gets a visible pointer, a caption bar, and a highlight ring around whatever is about to be clicked. Because the videos come from scripts, re-running them after a UI change regenerates every video, and a script that no longer matches the screen fails instead of quietly showing an old one.

## Install

The repo is private, so install it from GitHub (you need read access):

```
npm install --save-dev github:gldt-dboyle/tutorial-recorder playwright
npx playwright install chromium
```

`ffmpeg` is optional. With it, every `.webm` recording is also copied to an `.mp4` that QuickTime and most sharing tools can play (`brew install ffmpeg`).

## Use

```js
import { createRecorder, say, click, type, pointAt } from 'tutorial-recorder';

const recorder = createRecorder({
    outputDir: 'videos',
    hideSelectors: ['.phpdebugbar'], // anything that shouldn't appear on camera
    async login(page) {               // runs off camera before each recording
        await page.goto('https://my-app.test/login');
        await page.fill('#email', 'demo@example.com');
        await page.fill('#password', 'secret');
        await page.click('button[type=submit]');
        await page.waitForURL('**/dashboard');
    },
});

const { page, finish } = await recorder.startRecording('create-invoice');

try {
    await page.goto('https://my-app.test/dashboard');
    await say(page, 'To bill a customer, start from Invoices.');
    await click(page, page.getByRole('link', { name: 'Invoices' }));
    await type(page, page.getByLabel('Customer'), 'Jane Doe');
    await pointAt(page, page.getByRole('button', { name: 'Save' }));
    await say(page, 'Click Save, and the invoice is sent.');
} finally {
    console.log(`Saved ${await finish()}`); // videos/create-invoice.mp4
}
```

Pass `{ signedIn: false }` to `startRecording` for tutorials that begin on the sign-in screen. Set `HEADED=1` to watch the browser while it records.

| Helper | Does |
|---|---|
| `say(page, text, holdMs?)` | Shows a caption and holds while it's read (about 4 words a second) |
| `pointAt(page, locator)` | Glides the pointer to an element and rings it |
| `click(page, locator)` | Points, then clicks |
| `type(page, locator, text)` | Clicks into a field and types at a human pace |
| `clearOverlay(page)` | Hides the caption and ring |
| `mailpitLink(address, pattern)` | First matching link in the newest email [Mailpit](https://mailpit.axllent.org) caught for an address, e.g. a verification link |
| `clearMailpit(address)` | Deletes Mailpit's emails for an address so an old one isn't picked up |
| `toMp4(webmPath)` | The `.mp4` conversion `finish()` runs |
