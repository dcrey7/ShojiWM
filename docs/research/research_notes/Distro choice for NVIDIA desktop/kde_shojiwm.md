---
title: KDE Plasma 6 parts + ShojiWM per distro (CachyOS vs Fedora KDE, plus Bazzite, Nobara, Arch, NixOS, Debian 13)
date: 2026-11-20 11:13 CET
author: Claude (research sub-agent)
type: research-notes
status: frozen
---

# KDE Plasma 6 parts + ShojiWM per distro (Nov 2026)

## 1. Plasma / Qt / Mesa versions per distro and update speed

### Takeaway
On 20 Nov 2026, Arch (and so CachyOS repos), Fedora 44 and Fedora 45 all ship Plasma 6.8.3 and Mesa 26.2.x. Fedora gets new Plasma feature releases inside a stable release (F44 went 6.x -> 6.8), so Fedora is only days to weeks behind Arch on Plasma. Fedora is about one Qt minor behind (6.11 vs 6.12). Debian 13 is frozen on Plasma 6.3.6. NixOS 26.05 likely stays on 6.6.x.

### Cited Findings
- Arch `plasma-workspace` 6.8.3-1 in [extra], last updated 2026-11-15 — [Arch packages](https://archlinux.org/packages/?q=plasma-workspace)
- Local CachyOS machine (pacman sync DB, may be stale, user held KDE back on purpose): `plasma-workspace` 6.7.5-3.1 (cachyos-extra-znver4), `qt6-base` 6.12.0-2, `mesa` 26.2.4-1, `libinput` 1.32.0, `wayland` 1.26.0, `xorg-xwayland` 24.1.14, `seatd` 0.9.3, `rust` 1.99.0, `deno` 2.9.7 — local `pacman -Si`, 2026-11-20. Arch web shows 6.8.3, so the local DB lags the mirror.
- Fedora `plasma-workspace`: Rawhide 6.8.3-1.fc46, F45 6.8.3-1.fc45, F44 6.8.3-1.fc44, F43 6.7.6-1.fc43 — [Fedora packages](https://packages.fedoraproject.org/pkgs/plasma-workspace/plasma-workspace/)
- Fedora `qt6-qtbase`: Rawhide 6.12.0, F45 6.11.2, F44 6.11.2, F43 6.10.3 — [Fedora packages](https://packages.fedoraproject.org/pkgs/qt6-qtbase/qt6-qtbase/)
- Fedora `mesa-dri-drivers`: Rawhide 26.3.1, F45 26.2.7, F44 26.2.7, F43 25.3.6 — [Fedora packages](https://packages.fedoraproject.org/pkgs/mesa/mesa-dri-drivers/)
- Fedora 45 shipped late (missed its 20 Oct target); The Register coverage dated 4 Nov 2026; kernel 7.2.15 — [The Register](https://theregister.com/os-platforms/2026/11/04/fedora-45-is-finally-finished-and-fit/5307631); [It's FOSS](https://itsfoss.com/news/fedora-45-features/)
- Fedora KDE Plasma Desktop Edition 45 headlines Plasma 6.8 ("released on KDE's 30 year anniversary"), article dated 3 Nov 2026 — [Fedora Magazine](https://fedoramagazine.org/whats-new-in-fedora-kde-plasma-desktop-45/); It's FOSS says 6.7 (likely from beta, conflicts) — [It's FOSS](https://itsfoss.com/news/fedora-45-features/); AlternativeTo also says 6.8 — [AlternativeTo](https://alternativeto.net/news/2026/11/fedora-linux-45-arrives-with-gnome-51-kde-plasma-6-8-and-new-stratis-storage-support/)
- Precedent for Fedora shipping Plasma feature upgrades in-release: F43 launched with Plasma 6.4.5, then got Qt 6.10 + Plasma 6.5.1 as an update — [Linuxiac](https://linuxiac.com/fedora-43-officially-released/); [Bodhi FEDORA-2025-504ad1c52a](https://bodhi.fedoraproject.org/updates/FEDORA-2025-504ad1c52a)
- Debian 13 trixie ships Plasma 6.3.6 (2025 sources) — [Linuxiac](https://linuxiac.com/debian-13-to-ship-with-kde-plasma-6-3-6-desktop-environment/); [Debian wiki](https://wiki.debian.org/PkgQtKde/TrixieReleasePlans)
- NixOS: Plasma 6.7 merged into unstable; a forum poster does not expect a backport to 26.05, which keeps 6.6.x — [NixOS Discourse](https://discourse.nixos.org/t/kde-plasma-6-7-and-nixos-26-05/78351) (forum inference, not release notes)
- Nobara 43 (Fedora 43 base) shipped Dec 2025 with Plasma 6.5.4 — [PCGH](https://www.pcgameshardware.de/Linux-Software-26761/Specials/Nobara-43-mit-Linux-6-18-aufpoliert-1489761/); later Nobara 43 ISOs dated 2026-03-28 and 2026-04-19 exist — [LinuxCompatible](https://www.linuxcompatible.org/story/nobara-43-20260328-released), [MajorGeeks](https://www.majorgeeks.com/news/story/nobara_43_2026_04_19_released.html). Nobara moved to a "rolling-release model" with Nobara 42 (May 2025) — [Linuxiac](https://linuxiac.com/fedora-based-nobara-linux-goes-rolling/)

### Inferences
- For Plasma version, CachyOS and Fedora 44/45 are equal today (6.8.3). The real gap is Qt (6.12 vs 6.11) and that Fedora jumps happen in bigger batches after Bodhi testing.
- Fast Plasma updates are a risk for this desktop, not only a benefit: AeroThemePlasma replaces libplasma (see section 2), so each Plasma minor bump needs a matching ATP branch. Fedora's batched updates and `dnf versionlock` give a similar "hold" ability as CachyOS `IgnorePkg`.
- Debian 13 (Plasma 6.3.6) is too old for current ATP branches (6.6+). Not a fit.

### Gaps
- Exact Plasma version in Nobara as of Nov 2026, and whether Nobara 44/45 exists, not found.
- NixOS 26.05 exact `kdePackages` version not confirmed from release notes.
- Bazzite current Plasma version not checked (it follows Fedora's Kinoite base, so likely F44/F45 Plasma 6.8.x; unverified).
- Fedora 45 default Qt version at GA not stated in announcement; package DB shows 6.11.2.

## 2. Fedora KDE Edition, plasmashell under a non-KWin compositor, AeroThemePlasma support

### Takeaway
Plasma 6.8 drops the X11 session, so Fedora 45 KDE and Arch with 6.8 are Wayland only for Plasma. plasmashell under a non-KWin compositor is not supported by KDE, but ShojiWM documents it and implements the KDE protocols plasmashell needs. AeroThemePlasma documents both Arch (AUR packages, primary) and Fedora (from-source with a dnf list, contributor-maintained); a Plasma/6.8 branch exists since Nov 2026.

### Cited Findings
- AeroThemePlasma author (Mar 2026): AUR packages now available; "seems to work well on Fedora" but no Fedora packages; NixOS support in progress; "Plasma 6.8 will drop X11 support entirely" so ATP drops X11 code; "Aside from aeroshell-libplasma, all other packages are independent from their KDE Plasma counterparts" — [wackyideas blog](https://wackyideas.neocities.org/blogposts/2026/03/01/aerothemeplasma-new-version)
- ATP INSTALL (Plasma/6.7 branch) lists Arch, Fedora KDE, openSUSE, Ubuntu 25.10, Gentoo overlay, Void; "Dependencies for other distros besides Arch Linux have been provided by contributors and aren't updated frequently." Fedora command starts `dnf install gcc gcc-c++ cmake make extra-cmake-modules plasma-workspace-devel libksysguard-devel unzip kvantum ...` plus KF6/Qt6/KWin devel packages; Fedora needs `LIBEXEC_DIR=libexec`. After a full upgrade "KWin effects and libplasma modifications tend to stop working" and the install script must be re-run. No mention of non-KWin compositors or immutable distros — [ATP INSTALL 6.7](https://gitdab.com/Cynosphere/aerothemeplasma/raw/branch/Plasma/6.7/INSTALL.md)
- ATP branches (gitdab mirror): Plasma/6.8 updated 2026-11-08 ("Update OpenSUSE dependencies"), Plasma/6.7 2026-10-07, Plasma/6.6 2026-06-27 — [gitdab branches](https://gitdab.com/Cynosphere/aerothemeplasma/branches)
- KDE bug: plasmashell on Sway is not officially supported; tray popups become xdg-toplevels and get tiled — [KDE bug 476834](https://bugs.kde.org/show_bug.cgi?id=476834)
- KDE dev (2024): plasmashell "should work on other compositors ... to the degree that the other compositor allows/cooperates", tested only on kwin_wayland — [kde mailing list 2024-01](https://mail.kde.org/pipermail/kde/2024-January/029995.html)
- ShojiWM docs: ShojiWM hosts plasmashell and implements `org_kde_plasma_window_management` v18, `org_kde_plasma_shell` v8, `org_kde_plasma_virtual_desktop_management` v2, `xdg_toplevel_tag_manager_v1`; kglobalacceld runs on its X11 (xcb) backend via Xwayland; `activateLauncherMenu` D-Bus only works under KWin; ShojiWM does not speak `org_kde_kwin_shadow`; doc notes "`/usr/lib/kglobalacceld` is the Arch Linux path. Other distributions may install it under `/usr/libexec`." — local repo `docs/docs/configuration/kde-plasmashell.md`
- Fedora 43 already went Wayland-only for GNOME; F43 KDE shipped Plasma 6.4.5 — [It's FOSS](https://itsfoss.com/news/fedora-43-release/)

### Inferences
- The plasmashell-on-ShojiWM part is distro neutral: it depends on Plasma 6 + ShojiWM's protocol support, not on the distro. On Fedora the only config change is the kglobalacceld path (`/usr/libexec/kglobalacceld`, inferred from Fedora's libexec convention and ATP's `LIBEXEC_DIR=libexec`).
- ATP's KWin effects and decorations do nothing under ShojiWM (ShojiWM draws decorations). Only the plasmashell side (SevenStart, taskbar, Plasma style, libplasma fork) matters for this user. The libplasma fork is the version-locked piece.
- Arch/CachyOS is ATP's first-class target (AUR). Fedora works but is build-from-source with contributor-kept deps.

### Gaps
- No source confirms SevenStart specifically under any non-KWin compositor except this user's own ShojiWM setup.
- Fedora KDE Edition default session for F45 not stated explicitly in the Fedora Magazine post (Wayland only is inferred from Plasma 6.8 dropping X11). Fedora 42 "became official edition" fact not re-verified here.
- Whether ATP's Plasma/6.8 branch is complete/stable not verified (only branch date seen).

## 3. ShojiWM docs: supported distros and build dependencies; packaging per distro

### Takeaway
ShojiWM has no distro packages yet (AUR "planned just before the official release"). It documents a source installer, deps for Debian/Ubuntu and Arch, Ubuntu 25.04+/Debian 13+, and an experimental NixOS flake module. All deps are packaged on Fedora and Arch; Fedora is just undocumented.

### Cited Findings
- Install methods: `./dist/install.sh` (builds, installs compositor + TS runtime, default config, Wayland session; flags `--no-build`, `--no-portal`, `--no-config`); NixOS module `programs.shojiwm` (experimental); `nix develop`. "Distribution packages (AUR and similar) are planned for just before the official release." — [ShojiWM install docs](https://bea4dev.github.io/ShojiWM/docs/getting-started/installation)
- Deps: libwayland, libxkbcommon, libudev, libinput, libgbm, libseat, libxcb, xcb-util-cursor, xwayland. Arch names: `wayland libxkbcommon systemd-libs libinput mesa seatd libxcb xcb-util-cursor xorg-xwayland`. Debian/Ubuntu: `libwayland-dev libxkbcommon-dev libudev-dev libinput-dev libgbm-dev libseat-dev libxcb1-dev libxcb-cursor-dev xwayland`. Minimums: libwayland >= 1.23, xwayland >= 23.1 (else `SHOJI_XWAYLAND_SATELLITE=off`), PipeWire >= 0.3.77 for the portal. Ubuntu 25.04+ only; 22.04/24.04 not supported. Deno/V8 is embedded via RustyScript (no separate Deno install); Nix fetches pinned `rusty_v8`. Rust: "a recent Rust toolchain" — [ShojiWM install docs](https://bea4dev.github.io/ShojiWM/docs/getting-started/installation)
- Repo ships `flake.nix`, `flake.lock`, `nix/` — local repo listing; README: "Experimental NixOS" — local `README.md` line 21
- Fedora has `xwayland-satellite` (results across F43, F44, F45, Rawhide, EPEL 10) and `xorg-x11-server-Xwayland` — [Fedora package search](https://packages.fedoraproject.org/search?query=xwayland-satellite)

### Inferences
- Likely Fedora dnf names for the same deps (standard Fedora -devel naming, not checked one by one): `wayland-devel libxkbcommon-devel systemd-devel libinput-devel mesa-libgbm-devel libseat-devel libxcb-devel xcb-util-cursor-devel xorg-x11-server-Xwayland pipewire-devel`, plus `rust cargo` or rustup, `clang` (bindgen). Verify each on packages.fedoraproject.org before writing a guide.
- Fedora's Rust is usually one release behind upstream; rustup avoids that. Arch has rust 1.99.0 locally.
- The installer uses `sudo` to copy into `/usr`. This fails on atomic distros (read-only `/usr`).

### Gaps
- No ShojiWM doc names Fedora. Fedora dnf names above are not verified individually.
- No minimum Rust version stated.

## 4. Other Smithay compositors as packaging evidence

### Takeaway
Smithay compositors are well packaged on both sides: niri is in official Fedora repos (F43 to Rawhide, 26.04) and Arch extra; cosmic-comp and xwayland-satellite are in Arch extra.

### Cited Findings
- Fedora `niri`: Rawhide 26.04-3.fc46, F45 26.04-2.fc45 (testing 26.04-3), F44 26.04-1, F43 26.04-1 — [Fedora packages](https://packages.fedoraproject.org/pkgs/niri/niri/)
- Arch/CachyOS: `niri` 26.04, `cosmic-comp` 1.9.0, `xwayland-satellite` 0.8.3 (extra + cachyos-extra-znver4 rebuilds) — local `pacman -Si`, 2026-11-20
- Smithay powers COSMIC; layer-shell implemented by wlroots, Smithay and KWin — [Noctalia KDE docs](https://docs.noctalia.dev/noctalia/compositor-settings/kde/) (secondary)

### Inferences
- Any Smithay compositor builds fine on Fedora: the toolchain and libs that niri needs are a superset of ShojiWM's native deps (ShojiWM adds embedded V8).

### Gaps
- cosmic-comp version in Fedora not checked.

## 5. Customization freedom: atomic (Bazzite, Kinoite) vs traditional

### Takeaway
Atomic Fedora (Bazzite, Kinoite) allows Plasma themes in `~/.local/share`, but ShojiWM's `/usr` installer and ATP's libplasma replacement need `rpm-ostree` layering or a custom image. That is a poor fit for this from-source, frequently rebuilt desktop. Traditional Fedora KDE or CachyOS keeps it simple.

### Cited Findings
- Bazzite docs: put Plasma themes in `~/.local/share/plasma/` (desktoptheme), aurorae under `~/.local/share/aurorae/themes/`; Kvantum needs `rpm-ostree install kvantum`; SDDM themes layered "at your own risk" — [Bazzite docs](https://docs.bazzite.gg/General/Desktop_Environment_Tweaks/?h=theme) (no 2026 date seen)
- Community note: the built-in theme installer "may not install properly because the filesystem is slightly different" — [Universal Blue discourse](https://universal-blue.discourse.group/t/bazzite-desktop-environment-tweaks/574)
- ATP replaces libplasma (`aeroshell-libplasma`) and installs KWin/plasma components system-wide; needs re-run after upgrades — [wackyideas blog](https://wackyideas.neocities.org/blogposts/2026/03/01/aerothemeplasma-new-version); [ATP INSTALL](https://gitdab.com/Cynosphere/aerothemeplasma/raw/branch/Plasma/6.7/INSTALL.md)
- ShojiWM installer copies into `/usr` with `sudo` — [ShojiWM install docs](https://bea4dev.github.io/ShojiWM/docs/getting-started/installation)

### Inferences
- On Bazzite/Kinoite a user would have to: build ShojiWM in a toolbox, then package it as an RPM to layer, or build a custom bootc/ublue image. A libplasma replacement must also be layered and rebuilt per Plasma update. Doable, but every Plasma bump becomes an image rebuild.
- `/usr/local` on ostree systems is writable (maps to `/var/usrlocal`), so a binary could live there, but session files in `/usr/share/wayland-sessions` cannot; training-data knowledge, not verified for 2026.
- Ranking for this exact desktop: CachyOS/Arch (ATP AUR + documented ShojiWM deps + current Qt) > Fedora KDE 44/45 (all deps packaged, Plasma 6.8.3, ATP from source, undocumented ShojiWM path) > Nobara (Fedora + extra patches, lags) > NixOS (ShojiWM module exists but experimental; ATP NixOS support in progress; Plasma 6.6.x on 26.05) > Bazzite/Kinoite (immutable `/usr`) > Debian 13 (Plasma 6.3.6, too old).

### Gaps
- No 2026 Bazzite doc on installing a custom Wayland compositor found.
- NVIDIA-specific angle (driver packaging per distro) not covered in this note; another researcher covers it.

## Changelog
- 2026-11-20 11:13 CET — Created the notes (16 tool calls; local pacman + ShojiWM repo docs + web).
