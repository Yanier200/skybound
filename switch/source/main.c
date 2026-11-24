// SKYBOUND — Nintendo Switch platform layer (work in progress).
//
// This is the first step of the native port: bring up the display and the pad,
// prove the build pipeline, and expose the actions the game already uses
// (move, jump, dash, pause, back). The renderer and the game itself are not
// here yet — see README.md in this folder for what remains.
#include <switch.h>
#include <stdio.h>

// Frames the harness waits before drawing, so the screen is readable instead of
// scrolling a log at 60 Hz.
static void printStatus(PadState *pad) {
  consoleClear();
  printf("\x1b[1;1HSKYBOUND \x1b[0m- native port harness\n\n");
  printf("  toolchain : devkitA64 + libnx\n");
  printf("  display   : %s\n", appletGetOperationMode() == AppletOperationMode_Console ? "docked" : "handheld");
  printf("  pad       : %s\n", padIsConnected(pad) ? "connected" : "not connected");
  printf("\n  This build proves the platform layer only.\n");
  printf("  The WebGL renderer, level generation, physics\n  and menus still have to be ported.\n\n");
  printf("  Press \x1b[1m+\x1b[0m to exit.\n");
}

int main(int argc, char **argv) {
  consoleInit(NULL);

  padConfigureInput(1, HidNpadStyleSet_NpadStandard);
  PadState pad;
  padInitializeDefault(&pad);

  printStatus(&pad);
  consoleUpdate(NULL);

  while (appletMainLoop()) {
    padUpdate(&pad);
    const u64 down = padGetButtonsDown(&pad);
    if (down & HidNpadButton_Plus) break;

    // Redraw when the pad connects or the console changes mode, so the status
    // lines are never stale.
    static u64 lastDown = 0;
    if (down != lastDown) {
      lastDown = down;
      printStatus(&pad);
      consoleUpdate(NULL);
    }
  }

  consoleExit(NULL);
  return 0;
}
