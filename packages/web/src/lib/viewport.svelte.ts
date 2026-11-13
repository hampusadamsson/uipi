/**
 * The one breakpoint the JS knows about, kept byte-identical to Tailwind's
 * `lg` so the CSS and the component tree can never disagree about which
 * layout is on screen. Below it the app is "mobile": navigation and every
 * picker live in modal sheets (see `lib/components/ui/sheet`), because a phone
 * has no room for a permanent side rail or for a popover anchored to a 40px
 * chip.
 *
 * A hand-rolled listener rather than `MediaQuery` from `svelte/reactivity`:
 * that helper only invalidates on a *change* it observed itself, so a viewport
 * that was already narrow when it was constructed (a test, a cold load on a
 * phone) never propagates. Reading `innerWidth` into `$state` on every resize
 * keeps the value honest in both directions.
 */
const DESKTOP_MIN_WIDTH = 1024;

const read = (): number => (typeof window === "undefined" ? DESKTOP_MIN_WIDTH : window.innerWidth);

let width = $state(read());

if (typeof window !== "undefined") {
  window.addEventListener("resize", () => {
    width = read();
  });
  // rotation on iOS can change the width without firing resize on the document
  window.addEventListener("orientationchange", () => {
    width = read();
  });
}

/** `true` at `lg` and up: the desktop layout (rail + tabs + popovers). */
export const isDesktop = {
  get current(): boolean {
    return width >= DESKTOP_MIN_WIDTH;
  },
};
