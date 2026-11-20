# Gaming on an RTX 3090 desktop: CachyOS vs Fedora KDE (plus Bazzite, Nobara, Arch, NixOS, Debian)

Notes written 2026-11-20 11:13 CET. Sources are 2026 unless flagged. Phoronix pages returned HTTP 403 to the fetch tool, so Phoronix numbers below come from search snippets and secondary write-ups, not from the full article text.

## 1. Measured performance: CachyOS vs Fedora and others

### Takeaway
No source shows a large CachyOS gaming gain on NVIDIA. Phoronix CPU-heavy suites swing both ways: CachyOS led Fedora 44 by about 4% in April 2026, but Fedora 45 had the best overall geometric mean in October 2026. Gaming FPS comparisons on NVIDIA show gaps of about 0 to 3%, inside run-to-run noise.

### Cited Findings
- Phoronix, 28 Oct 2026, AMD Ryzen 9 9900X3D2 desktop: Fedora Workstation 45 was fastest on the overall geometric mean of 136 tests; CachyOS fell behind Fedora 45 and Ubuntu 26.10 because of drops in some video encoders and other workloads. CachyOS still took the most first places (about 40% of tests). Fedora won x265, ClickHouse, VVenC; CachyOS won SVT-AV1 and Sonic JSON. — [Phoronix](https://www.phoronix.com/review/cachyos-ubuntu2610-fedora45) (via search snippet; full page 403)
- Phoronix, April 2026, HP Z6 G5 A workstation: CachyOS geometric mean 540.20 vs Fedora Workstation 44 518.15 (about 4.3% ahead) and Ubuntu 26.04 521.86 (about 3.5%). — [Phoronix](https://www.phoronix.com/review/cachyos-ubuntu-2604-fedora-44/6); figures from [comss.ru summary](https://www.comss.ru/page.php?id=20465). One English write-up claims 12-15%, which conflicts with these numbers — [WebProNews](https://www.webpronews.com/cachyos-outpaces-ubuntu-26-04-and-fedora-44-benchmarks-expose-linux-speed-gaps-in-2026/). Treat the 12-15% as wrong.
- These Phoronix runs are CPU/workstation suites (encoders, databases, compilers), not GPU gaming tests. I found no Phoronix NVIDIA gaming comparison of CachyOS vs Fedora in 2025-2026.
- RTX 5080, 1080p High/Ultra: CachyOS about 2.4% more average FPS than Bazzite; Kingdom Come Deliverance 2 was 137 FPS on Bazzite vs 136 on CachyOS. — [Deltias Gaming](https://deltiasgaming.com/?p=397111) (via search snippet)
- Cyberpunk 2077 1080p High: CachyOS 78, Bazzite 75, Fedora 72 FPS; GPU not stated, and the page credits BORE without proof. Low quality source. — [tech-insider.org](https://tech-insider.org/bazzite-vs-cachyos-2026/)
- A CachyOS forum user recalls 15-50% FPS gains after moving from Bazzite, but says the numbers are from memory, not measured. The same user says a CachyOS kernel plus GPU driver update made the system unbootable in January. — [CachyOS forum, 28 Feb 2026](https://discuss.cachyos.org/t/nobara-vs-cachyos/23456/31.md)
- CachyOS's own wiki says to expect modest gains: "software tweaks rarely match a hardware upgrade". — [CachyOS wiki: Gaming](https://wiki.cachyos.org/configuration/gaming/)
- CachyOS's wiki says DirectX 12 performance drops on NVIDIA are not caused by CachyOS and have no known workaround. — [CachyOS wiki: Gaming](https://wiki.cachyos.org/configuration/gaming/)
- The NVIDIA DX12 (vkd3d-proton) gap vs Windows: one forum user estimates about 18% average loss, more with ray tracing. Vulkan 1.4.340 added VK_EXT_descriptor_heap (NVIDIA + Valve) as the likely fix; vkd3d-proton support was a draft PR (#2805) in the results. — [NVIDIA forum thread](https://forums.developer.nvidia.com/t/directx12-performance-is-terrible-on-linux/303207?page=37); [lavx news](https://news.lavx.hu/article/vulkan-1-4-340-brings-descriptor-heap-extension-to-tackle-proton-performance-issues)

### Inferences
- On a GPU-bound RTX 3090, the distro choice changes FPS by a few percent at most. The NVIDIA DX12 gap (driver plus vkd3d-proton) is far larger than any distro gap and affects every distro the same way.
- x86-64-v3/v4 packages and BORE help CPU-bound work and maybe frame-time smoothness, but no 2026 controlled source quantifies a gaming frame-time gain on NVIDIA.

### Gaps
- No controlled 2025-2026 benchmark of CachyOS vs Fedora KDE on an NVIDIA GPU in games (average FPS or 1% lows).
- No measurement isolating BORE vs EEVDF, or x86-64-v3 vs generic packages, for games.
- Whether vkd3d-proton descriptor-heap support has shipped by Nov 2026 is not confirmed.

## 2. Steam, Proton, Proton-GE and gaming meta packages

### Takeaway
All distros run Steam well. CachyOS gives one-click meta packages and its own Proton build. Fedora needs RPM Fusion or Flatpak Steam. Bazzite and Nobara ship Steam and tools preinstalled. Flatpak Steam on NVIDIA needs a matching NVIDIA runtime after each driver update.

### Cited Findings
- CachyOS: `cachyos-gaming-meta` (libraries) and `cachyos-gaming-applications` (Steam, Heroic, Lutris, Faugus, Gamescope, MangoHud, GOverlay); CachyOS Hello installs both with one button. — [CachyOS wiki](https://wiki.cachyos.org/configuration/gaming/)
- Proton-CachyOS: based on Proton bleeding-edge, wine-staging patches, FSR, cutscene codecs, umu/protonfixes, NTSync on by default. Use `proton-cachyos-slr` for EAC/BattlEye games. Wiki advises Valve Proton as the global default and custom Proton per game. — [CachyOS wiki](https://wiki.cachyos.org/configuration/gaming/)
- CachyOS NVIDIA tips: raise `__GL_SHADER_DISK_CACHE_SIZE`; use `dlss-swapper` to force newest DLSS preset; `game-performance %command%` for performance mode; do not mix GameMode and ananicy-cpp. — [CachyOS wiki](https://wiki.cachyos.org/configuration/gaming/)
- Fedora: Steam and the NVIDIA driver come from RPM Fusion; Fedora Workstation also offers a filtered Steam repo via the third-party repo switch. — [computingforgeeks](https://computingforgeeks.com/gaming-on-fedora/)
- Bazzite Desktop Edition ships Steam and gaming tools in the base image. — [Bazzite FAQ](https://docs.bazzite.gg/General/FAQ/)
- Nobara 44 preinstalls Steam, Lutris, Gamescope, MangoHud, umu-launcher, ProtonPlus (for GE-Proton), OBS and a DaVinci Resolve runtime. — [PCGH, Nobara 44](https://www.pcgameshardware.de/Linux-Software-26761/News/Nobara-44-streicht-Nvidia-Image-1552510/)
- Flatpak pitfall: Flatpak NVIDIA GL libraries must match the host driver version. Example: host 595.91.07 vs Flatpak runtime 595-84 gave white/transparent Proton games; `flatpak update` fixed it. — [Zorin forum](https://forum.zorin.com/t/report-proton-games-on-steam-flatpak-breaking-with-white-transparent-screen-after-nvidia-driver-update/68809); on Fedora DNF and Flatpak do not coordinate — [Fedora Discussion](https://discussion.fedoraproject.org/t/nvidia-flatpak-opengl-error-after-every-driver-update/182187)
- Native Steam pitfall: its bundled runtime can override system libs (libGL "unable to load driver"). — [Gentoo wiki](https://wiki.gentoo.org/wiki/Steam/Client_troubleshooting); a CachyOS user fixed a native Steam launch failure on NVIDIA by using Flatpak — [CachyOS forum](https://discuss.cachyos.org/t/fixed-steam-native-failing-to-launch-on-fresh-install-nvidia/31264)

### Inferences
- Native Steam from the distro repo is the simpler path on NVIDIA on rolling distros (CachyOS, Arch) because host driver and libs update together. Flatpak Steam adds one extra step after each driver update.

### Gaps
- No 2026 source compares Flatpak vs native Steam FPS.

## 3. NVIDIA on Wayland for gaming (2025-2026)

### Takeaway
Explicit sync works since driver 555 + Plasma 6.1. Drivers moved fast in 2026 (580 LTS, 590, 595, now 615.x). DLSS, frame generation and Reflex work through Proton. HDR and VRR on NVIDIA Wayland still have scattered bug reports. Pascal and older are dropped from new drivers; the RTX 3090 (Ampere) is fully supported on nvidia-open.

### Cited Findings
- 580.126.18 was a "recommended" (production) release in Feb 2026. — [GamingOnLinux](https://www.gamingonlinux.com/2026/02/nvidia-recommended-driver-580-126-18-released-for-linux)
- 590 (Dec 2025-Jan 2026): Wayland minimum 1.20, EGL multisampling fixes, faster Vulkan swapchain recreation. — [Linuxiac](https://linuxiac.com/nvidia-releases-linux-driver-590-48-with-wayland-and-vulkan-fixes/). Anecdote: Stalker 2 crashed on 590, fine on 580. — [GamingOnLinux comments](https://www.gamingonlinux.com/2025/12/nvidia-beta-driver-590-44-01-released-for-linux/page=1/)
- 595.58.03 (Mar/Apr 2026): first stable of the 595 branch, better Wayland support. — [UbuntuHandbook](https://ubuntuhandbook.org/index.php/2026/03/nvidia-595-58-03-released-with-better-wayland-linux-gaming-support/). Open driver 595 dropped GP10x (Pascal) support in March 2026. — [PCGH](https://www.pcgameshardware.de/Linux-Software-26761/News/Nobara-44-streicht-Nvidia-Image-1552510/)
- 615.78.08 (Oct 2026): VK_NV_low_latency2 rev 3 for better latency/stutter with VKD3D-Proton with Frame Generation; possible crash fix for Vulkan HDR with Wayland color-management-v1. — [Phoronix](https://www.phoronix.com/news/NVIDIA-615.78.08-Linux); [PCGH](https://www.pcgameshardware.de/Linux-Software-26761/News/Nvidia-Linux-Treiber-615-78-08-VKD3D-Proton-Frame-Generation-1556111/)
- 615.71.09 reportedly brought Reflex to Proton by default and fixed Smooth Motion freezes (Japanese source, not verified against NVIDIA notes). — [gaming-st](https://gaming-st.com/news/nvidia-linux-615-71-09-proton-reflex/)
- NVIDIA docs: DLSS Frame Generation and Smooth Motion (driver frame generation) should not be used together. — [NVIDIA driver guide 595: gaming](https://docs.nvidia.com/datacenter/tesla/driver-installation-guide/595/gaming.html)
- DLSS 4.5 (CES 2026) and DLSS Updater got Linux support. — [GamingOnLinux](https://gamingonlinux.com/2026/01/nvidia-announce-dlss-4-5-with-dynamic-multi-frame-generation-plus-dlss-updater-gets-linux-support)
- Proton-CachyOS's vkd3d-low-latency fork emulates Reflex but does not support Frame Generation per its docs. — [PCGH](https://www.pcgameshardware.de/Linux-Software-26761/News/Nvidia-Linux-Treiber-615-78-08-VKD3D-Proton-Frame-Generation-1556111/)
- Explicit sync: Plasma 6.1 Wayland plus driver 555.58+. — [Linux Journal](https://www.linuxjournal.com/content/kde-plasma-6-wayland-payoff-years-plumbing)
- VRR/HDR: 595 feedback thread lists VRR backlight flicker and broken HDR (user reports). — [NVIDIA forum](https://forums.developer.nvidia.com/t/595-release-feedback-discussion/362561?page=19). KDE bug (Jan 2026, Plasma 6.5.4): `KWIN_DRM_NO_AMS=1` breaks VRR with HDR on, also on AMD. — [KDE bug 514454](https://bugs.kde.org/show_bug.cgi?id=514454)
- Fedora 44 uses RPM Fusion's 595 branch by default; Maxwell/Pascal need the 580xx legacy branch. — [computingforgeeks](https://computingforgeeks.com/install-nvidia-drivers-fedora/)
- Bazzite: `-nvidia-open` image for Turing and newer (all RTX); `-nvidia` legacy image for Maxwell/Pascal/Volta; drivers update only with the image. — [Bazzite FAQ](https://docs.bazzite.gg/General/FAQ/)

### Inferences
- For an RTX 3090 the driver is no blocker on any distro with a current branch. Fast-moving branches (590, 595, 615) bring both fixes and regressions; a rolling distro gets them first, Fedora a little later, Debian much later.
- HDR on NVIDIA KDE Wayland is usable in 2026 but still has bug reports; test on the actual monitor.
- Note for this user: memory says his PC runs a 580xx driver with a clock cap because of Xid 109 errors. Staying on 580 means missing the 615 Proton latency/frame-gen fixes.

### Gaps
- No official 2026 NVIDIA statement that VRR and HDR are fully fixed on Wayland.
- Current "recommended" branch on NVIDIA's download page in Nov 2026 not confirmed.

## 4. Anti-cheat

### Takeaway
Anti-cheat is per game, not per distro. No distro choice fixes a blocked game. Fortnite, Valorant, League of Legends, Warzone, GTA Online and Apex Legends do not run on any Linux.

### Cited Findings
- Blocked "and likely never will": Fortnite, Valorant, Warzone. Works well: Counter-Strike 2, ARC Raiders, Marvel Rivals. (Published 21 May 2026, updated 23 Jun 2026.) — [GamingOnLinux anti-cheat guide](https://www.gamingonlinux.com/guides/view/anticheat-check-which-competitive-games-actually-work-on-linux-steamos/)
- Readers add DragonBall FighterZ, Marvel Tokon and 2XKO as blocked (unverified comments). — [GamingOnLinux](https://www.gamingonlinux.com/guides/view/anticheat-check-which-competitive-games-actually-work-on-linux-steamos/)
- EAC and BattlEye support Proton, but each developer must enable it per game. Apex Legends was blocked on Linux in late 2024; GTA Online blocked; Vanguard (Valorant, LoL) unsupported; Rocket League kept working after EAC in April 2026. — [gaming-st](https://gaming-st.com/trouble-settings/linux-anticheat-eac-battleye-vanguard-status-2026/)
- AreWeAntiCheatYet snapshot: of 1,166 tracked games, 640 Broken and 53 Denied (third-party blog figure). — [Switchblade Gaming](https://www.switchbladegaming.com/handheld-gaming/anti-cheat-steam-deck-linux-2026/). Conflicting EAC/BattlEye counts exist in other blogs; not verified.
- ARC Raiders broke for some Linux players in June 2026; a fix was promised. — [GamingOnLinux](https://www.gamingonlinux.com/2026/06/arc-raiders-is-broken-for-some-linux-steamos-players-but-a-fix-is-on-the-way/)
- CachyOS recommends `proton-cachyos-slr` for EAC/BattlEye games. — [CachyOS wiki](https://wiki.cachyos.org/configuration/gaming/)

### Inferences
- If the user plays any kernel anti-cheat title, he needs Windows (dual boot) whatever the distro.

### Gaps
- Exact AreWeAntiCheatYet counts as of Nov 2026 not read directly from the site.

## 5. Bazzite, Nobara, Arch, NixOS, Debian: what they add and fit for a custom desktop

### Takeaway
Bazzite is an image-based Fedora (KDE or GNOME) with good NVIDIA images, but a custom Wayland compositor needs a custom image built with a Containerfile/BlueBuild, not casual package installs. Nobara is mutable Fedora with a CachyOS kernel and gaming tools; since Nobara 44 one ISO serves NVIDIA too. Debian lags on NVIDIA drivers.

### Cited Findings
- Bazzite: only KDE Plasma or GNOME images; switching desktop by rebase often breaks config; for another DE or standalone WM, build a custom image based on Bazzite. Bazzite does not support X11. — [Bazzite FAQ](https://docs.bazzite.gg/General/FAQ/)
- Bazzite rpm-ostree layering keeps Fedora packages across updates but "can be destructive and may prevent updates"; heavy layering users should build a custom image. — [Bazzite docs rpm-ostree](https://docs.bazzite.gg/uk/Installing_and_Managing_Software/rpm-ostree/); [DeepWiki summary](https://deepwiki.com/bazzite-org/docs.bazzite.gg/7.4-system-level-package-management)
- Custom images: fork the repo, build with GitHub Actions, sign with a Cosign key pair; BlueBuild recipes take a base image (FROM). — [ublue-os/bazzite](https://github.com/ublue-os/bazzite); [Universal Blue forum](https://universal-blue.discourse.group/t/making-my-first-image/9276/1)
- Precedent: bazzite-atty is a BlueBuild image that ships the niri Wayland compositor; a Fedora 44 bootc image ships Hyprland from a COPR. — [bazzite-atty](https://awesome.ecosyste.ms/projects/github.com%2Fatty303%2Fbazzite-atty); [Fedora Discussion](https://discussion.fedoraproject.org/t/showcase-learning-project-building-a-pure-fedora-44-bootc-hyprland-nix-image/185699)
- Nobara 44 (28 Aug 2026): Fedora 44 base (Linux 6.19, KDE Plasma 6.6), kernel from CachyOS, NTSYNC, AppArmor instead of SELinux; no separate NVIDIA ISO anymore, driver via installer checkbox, Nobara Driver Manager or `nobara-driver-tui`; branches Production/New Feature/Beta; Turing+ only; Secure Boot must be off for new installs; no X11 since Nobara 41. — [PCGH](https://www.pcgameshardware.de/Linux-Software-26761/News/Nobara-44-streicht-Nvidia-Image-1552510/)
- Nobara 43 had separate NVIDIA ISOs (e.g. Nobara-43-Official-NV-2026-01-26). — [Nobara downloads](https://nobaraproject.org/download.html)
- Fedora with Secure Boot: sign akmods with a key (kmodgenca + mokutil); else the driver does not load and the screen stays blank. — [RPM Fusion NVIDIA howto](https://rpmfusion.net/Howto/NVIDIA?action=raw)
- Debian 13 trixie: stock and backports driver is 550.163.01; kernel 6.16+ needed 580+, though 550 proprietary built on the 6.17 backports kernel and the open flavor failed; newer branches only from NVIDIA's own repo. — [linuxcapable](https://www.linuxcapable.com/install-nvidia-drivers-on-lmde); [NVIDIA forum](https://forums.developer.nvidia.com/t/nvidia-driver-compatibility-with-linux-kernel-6-17-debian-trixie/354354/6)

### Inferences
- For a user who builds and runs his own Wayland compositor (ShojiWM) with many custom packages, a mutable distro (CachyOS, Arch, Fedora KDE) is far less friction than Bazzite. On Bazzite each change means an image rebuild or risky layering; a dev compositor can still run from the home folder (user-space binary), but its system dependencies must be in the image.
- Nobara is close to "Fedora KDE plus CachyOS kernel plus gaming tools" but is maintained by a small team and needs Secure Boot off.
- Arch gives the same packages as CachyOS minus the tuned kernel, v3/v4 builds and meta packages; the gaming result should be near identical on a GPU-bound 3090.
- Debian is the weakest choice for NVIDIA gaming in 2026 because of the old 550 driver.

### Gaps
- No NixOS-specific 2026 gaming source found. (Known only from training data, not verified: NixOS sets NVIDIA via `hardware.nvidia` options and `programs.steam`; reproducible but steep learning curve.)
- No 2026 source on Arch-specific gaming setup beyond CachyOS's (CachyOS is Arch-based).
