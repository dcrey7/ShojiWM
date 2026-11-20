# Long-term stability, rollback and security: CachyOS vs Fedora KDE (plus Bazzite, Nobara, Arch, NixOS, Debian 13)

Notes written 2026-11-20 11:13 CET. Sources are mostly 2025-2026. Many breakage reports are forum anecdotes, and the notes flag them as such.

## Upgrade model and how upgrades go in practice

### Takeaway
CachyOS and Arch roll: you get new kernels, NVIDIA drivers and Plasma within days, and Arch posts a few "manual intervention" notices per year. Fedora ships every ~6 months and supports each release until 1 month after release N+2 (about 13 months). Debian 13 gives ~5 years with no big jumps. Fedora 45 shipped in early Nov 2026 with Plasma 6.8 and kernel 7.2.

### Cited Findings
- Fedora policy: release N is maintained until 1 month after release N+2 (e.g. F43 until 1 month after F45). — [Fedora wiki lifecycle](https://fedoraproject.org/wiki/User:Jkurik/Fedora_Release_Life_Cycle.diff)
- Fedora 43 released 28 Oct 2025 (slipped from 21 Oct). — [Linuxiac](https://linuxiac.com/fedora-43-final-build-approved-official-release-set-for-october-28/)
- Fedora 43 EOL listed as 9 Dec 2026 (tracker, derived from F45 date). — [endoflife.ai](https://endoflife.ai/article-fedora-43-eol)
- Fedora 42 reached EOL on 2026-05-28 (one day late vs plan). — [Fedora devel-announce](https://lists.fedoraproject.org/archives/list/devel-announce@lists.fedoraproject.org/thread/UBI57B7TD2TTKXWEFI7GEKRD2TQILVX4/); [Neowin](https://www.neowin.net/news/fedora-42-is-officially-dead-and-you-need-to-upgrade-your-pc-right-now/)
- Fedora 44: released ~28 Apr 2026, end of support ~2 Jun 2027 (tracker). — [endoflife.ai via search](https://isitpatched.com/eol/fedora)
- Fedora 45 released early Nov 2026 (missed 20 Oct target); KDE edition ships Plasma 6.8 (6.8.2 per Linuxiac), kernel 7.2. ItsFOSS says Plasma 6.7, which conflicts with Fedora Magazine and Linuxiac. — [Fedora Magazine](https://fedoramagazine.org/whats-new-in-fedora-kde-plasma-desktop-45/); [Linuxiac](https://linuxiac.com/?p=222316); [Linux Magazine](https://www.linux-magazine.com/Online/News/Fedora-45-Now-Available?category=13387); [ItsFOSS](https://itsfoss.com/news/fedora-45-features/)
- Fedora supports upgrading across two releases (e.g. 42 to 44 directly). — [Neowin](https://www.neowin.net/news/fedora-42-is-officially-dead-and-you-need-to-upgrade-your-pc-right-now/)
- Arch "manual intervention" news items 2025-2026 (from search over archlinux.org/news and arch-announce; some via mirrors): Plasma 6.4.0 X11 split (2025-06-20), linux-firmware (2025-06-21), zabbix (2025-08-04), dovecot (2025-10-31), waydroid (2025-11-06), .NET 10 (2025-12-11), kea (2026-04-07), virtualbox-ext-vnc (2026-07-21), mkinitcpio 42 TPM2 LUKS (2026-09-22). Only Plasma, linux-firmware and mkinitcpio touch a typical desktop. — [Arch news](https://archlinux.org/news/); [arch-announce Apr 2026](https://lists.archlinux.org/archives/list/arch-announce@lists.archlinux.org/2026/4/)
- Debian 13 "trixie" released 9 Aug 2025; full support to 9 Aug 2028, LTS to 30 Jun 2030; point releases every ~2 months (13.6 on 11 Jul 2026; some localized pages show 13.7 on 12 Sep 2026). Freexian paid ELTS to 30 Jun 2035. Shipped kernel 6.12 LTS and Plasma 6.3. — [Debian release info](https://www.debian.org/releases/trixie/); [Freexian](https://www.freexian.com/lts/extended/docs/debian-13-support/); [AlternativeTo](https://alternativeto.net/news/2025/8/debian-13-trixie-released-with-linux-kernel-6-12-lts-gnome-48-kde-6-3-and-more)

### Inferences
- Over 4 years, Fedora means ~8 major upgrades (or 4 if you skip one each time with the N+2 jump). CachyOS means continuous small upgrades with no "big day".
- Debian 13 freezes Plasma at 6.3 for its life. That clashes with a heavily customized, current-Plasma desktop and with new NVIDIA GPUs.

### Gaps
- I found no measured success rate for `dnf system-upgrade`. Evidence is anecdotal only (see NVIDIA section).
- I did not fetch the full Arch news page; the list above may miss items.

## Notable breakages 2025-2026 (NVIDIA, kernel, Plasma)

### Takeaway
Both distros had NVIDIA breakages in 2026. On CachyOS they come more often and arrive with each new driver or kernel (Mar, Aug, Sep, Oct, Nov 2026 threads). On Fedora they cluster around the major upgrade (F44 dropped old GPUs to the 580xx branch) and akmod rebuild failures after kernel bumps.

### Cited Findings
CachyOS (forum anecdotes, no official advisories found):
- Mar 2026: kernel update left an RTX 5070 with no NVIDIA modules; did not happen on vanilla kernel; driver reinstall fixed it. — [GitHub linux-cachyos #782](https://github.com/CachyOS/linux-cachyos/issues/782)
- Aug 2026: v4 repo shipped NVIDIA 610.57.04-1 without matching lib32-nvidia-utils; update failed on dependencies. — [CachyOS forum](https://discuss.cachyos.org/t/cachyos-v4-nvidia-610-57-04-1-update-broken/33847)
- Sep 2026: 615.71 driver or systemd 261.3 caused Plasma login loop on RTX 50-series; users advised staying on 610.57. — [CachyOS forum (search summary)](https://discuss.cachyos.org/t/update-broke-boot-infinite-loading/35569)
- Oct 2026: update with kernel 7.3 + NVIDIA packages broke the screen on an RTX 3060 laptop; advice: use the LTS kernel. — [CachyOS forum](https://discuss.cachyos.org/t/new-update-broke-nvidia-oct-2026/37992)
- 22 Oct 2026: HDMI flicker on hybrid Intel/NVIDIA after update; fixed by a later update. — [CachyOS forum](https://discuss.cachyos.org/t/severe-display-artifacts-and-flickering-on-nvidia-hdmi-output-after-todays-first-upgrade-2026-10-22/37838)
- Nov 2026: NVIDIA 620 gave tint/bad resolution, Steam freeze, UE5 crashes; users downgraded to 615. Unclear if upstream NVIDIA bug. — [CachyOS forum](https://discuss.cachyos.org/t/nvidia-driver-620-update-breaks-graphics/38920)
- A thread reports an update that broke boot where the snapshot booted but the updated system came up read-only. — [CachyOS forum](https://discuss.cachyos.org/t/system-becomes-unbootable-after-updating-btrfs-snapshot-works-but-updated-system-boots-read-only/34540?page=2)

Fedora (forum anecdotes):
- Upgrade 43 to 44 (spring 2026): RPM Fusion's 595+ driver auto-installs and drops GeForce 10xx and older; fix is `akmod-nvidia-580xx`. — [Fedora Discussion](https://discussion.fedoraproject.org/t/upgrading-to-fedora-44-breaks-nvidia-driver-for-older-gpus-geforce-10xx-and-older/192286); [Fedora Discussion](https://discussion.fedoraproject.org/t/nvidia-kernel-module-missing-falling-back-to-nouvea-fedora-44/192244)
- F44: RPM Fusion 590.x akmod failed to build against kernel 6.19.x. — [Fedora Discussion](https://discussion.fedoraproject.org/t/fedora-44-kernel-6-19-x-nvidia-akmod-cannot-be-built/181035)
- Kernel 7.2.4 update left llvmpipe instead of NVIDIA. — [Fedora Discussion](https://discussion.fedoraproject.org/t/conflicting-nvidia-driver/201983)
- F44 beta: Secure Boot MOK flow reportedly behaves differently with driver 595 vs 580. — [Fedora Discussion](https://discussion.fedoraproject.org/t/upgrade-to-fedora-44-beta-secure-boot-issues-kde-plasma/184322)
- Kinoite 43 to 44 via Discover: "no boot" report. — [Fedora Discussion](https://discussion.fedoraproject.org/t/kinoite-43-to-44-updated-via-discover-no-boot/192864)
- Usual fix: `akmods --force --rebuild`, rebuild initramfs with dracut. — [Fedora Discussion](https://discussion.fedoraproject.org/t/nvidia-driver-fails-to-boot-on-kernel-update-in-fedora-42-hybrid-graphics-mx350/153763)

### Inferences
- On Fedora, the old kernel stays in GRUB (Fedora keeps several kernels by default; known behavior, not sourced here), so a failed akmod build usually means "boot previous kernel", not a dead system.
- On CachyOS, the defence is: keep `linux-cachyos-lts` installed as a second kernel, hold NVIDIA packages as a set, and rely on Limine snapshots. The machine in question already runs `6.18.55-2-cachyos-lts`.

### Gaps
- No source counts breakage frequency per distro. Forum thread counts are biased (CachyOS has many gaming users with new GPUs).
- No official CachyOS or RPM Fusion post-mortems found.

## Snapshots and rollback

### Takeaway
CachyOS gives boot-to-snapshot out of the box on Btrfs: snapper + snap-pac snapshot every pacman run, and limine-snapper-sync adds them to the Limine menu (Limine default since Jan 2026). Fedora KDE uses Btrfs but ships no snapshot tooling; you add snapper, a DNF5 actions hook and grub-btrfs (built from source or COPR) by hand. Kinoite/Bazzite and NixOS have atomic rollback by design. An ext4 install can add Timeshift rsync mode without reinstall, but restores are slower and not bootable from a menu.

### Cited Findings
- Mar 2025: CachyOS added Limine with direct Btrfs snapshot boot entries, enabled out of the box on Btrfs installs. — [Linuxiac Mar 2025](https://linuxiac.com/?p=163234); [CachyOS Mar 2025 changelog](https://discuss.cachyos.org/t/cachyos-march-2025-changelog/7567)
- Aug 2025: GRUB + Btrfs also gets bootable snapshots automatically. — [CachyOS Aug 2025 release](https://www.cachyos.org/blog/2508-august-release)
- Jan 2026: Limine is the installer default; boot partition raised to 4192 MB for limine-snapper-sync. — [CachyOS Jan 2026 release](https://cachyos.org/blog/2601-january-release/); [Linuxiac](https://linuxiac.com/cachyos-january-2026-release-brings-installer-rework-and-wayland-by-default/)
- CachyOS wiki: default snapper config covers only `/`; snap-pac is included by default so every pacman transaction makes pre/post snapshots; limine-snapper-sync config `MAX_SNAPSHOT_ENTRIES=10`. Rollback: boot snapshot from Limine menu (read-only), accept restore prompt, reboot. Caveat: "If the snapshot you want to restore from involved a kernel update, you won't be able to rollback." And snapshots are not backups. — [CachyOS wiki Btrfs snapshots](https://wiki.cachyos.org/configuration/btrfs_snapshots/)
- Common failure: limine-snapper-sync stops adding entries when ESP use passes 85%. — [CachyOS forum](https://discuss.cachyos.org/t/limine-btrfs-snapshots-stopped-being-added-to-bootloader-snapper/20388)
- Another report: snapshot restore didn't seem to work after a breaking update. — [CachyOS forum](https://discuss.cachyos.org/t/update-broke-my-system-and-snapshot-restore-doesnt-seem-to-work/31954)
- Fedora: grub-btrfs is not packaged in Fedora (build from source or COPR `kylegospo/grub-btrfs`); old python3-dnf-plugin-snapper broke with DNF5 in F41, guides use libdnf5-plugin-actions; snapper covers only root by default. Users on F44 KDE ask for help since nothing is preconfigured. — [Fedora Discussion guide](https://discussion.fedoraproject.org/t/btrfs-snapshots-in-fedora-the-definitive-step-by-step-easy-and-safe-guide/194483); [COPR grub-btrfs](https://copr.fedorainfracloud.org/coprs/kylegospo/grub-btrfs); [Fedora Discussion F44 KDE](https://discussion.fedoraproject.org/t/fresh-btrfs-install-of-fedora-44-kde-help-required-for-configuring-snapshots/199639); [Fedora Discussion "difficult"](https://discussion.fedoraproject.org/t/difficult-to-enable-btrfs-snapshots/200470)
- Framework's KB documents restoring Fedora root snapshots with Btrfs Assistant. — [Framework KB](https://knowledgebase.frame.work/en_us/fedora-system-restore-root-snapshots-using-btrfs-assistant-rkHNxajS3)
- Kinoite/Atomic (and so Bazzite): pick the previous deployment in the boot menu (temporary) or `rpm-ostree rollback` (permanent); one rollback kept by default, more with `ostree admin pin`. — [Fedora Atomic docs](https://docs.fedoraproject.org/fr/atomic-desktops/updates-upgrades-rollbacks/)
- One Kinoite 44 user found the boot menu hidden and fixed with a GRUB timeout file (anecdote). — [Fedora Discussion](https://discussion.fedoraproject.org/t/after-fresh-kinoite-44-install-and-update-no-opportunity-to-choose-previous-ostree/199640)
- NixOS: previous generations stay in the GRUB/systemd-boot menu; `nixos-rebuild switch --rollback` reverts. — [nixos-rebuild man page](https://www.mankier.com/8/nixos-rebuild); [NixOS wiki](https://wiki.nixos.org/wiki/Nixos-rebuild)
- Timeshift on ext4 uses rsync + hard links; first snapshot is a full copy; restore needs a reboot or a live USB; snapshots can live on another Linux-formatted disk. — [ComputingForGeeks](https://computingforgeeks.com/timeshift-backup-restore-linux/); [Timeshift wiki](https://github.com/linuxmint/timeshift/wiki)

### Inferences
- For "recover fast from a bad update", the ranking is roughly: NixOS / Bazzite / Kinoite (atomic, whole-image) > CachyOS on Btrfs + Limine (automatic, boot-menu) > Fedora KDE after manual snapper setup > Fedora KDE stock (old kernels only) > ext4 + Timeshift rsync (works, but from a live USB if unbootable).
- Snapper rollbacks cover `/` only; `/home` (where KDE customizations live) is not rolled back. Back up `~/.config` separately on any distro.
- Converting ext4 to Btrfs in place exists (`btrfs-convert`) but is not covered by sources here; a reinstall is the safe route.

### Gaps
- Whether the CachyOS installer defaults to Btrfs (vs letting the user pick) is not stated in the sources found.
- No source on Bazzite/Kinoite rollback with a heavily customized Plasma (layered RPMs) or a custom compositor like ShojiWM.

## Security defaults

### Takeaway
Fedora is stronger by default: SELinux enforcing, firewalld on, signed shim so Secure Boot works out of the box (NVIDIA akmods need a one-time MOK key). CachyOS/Arch ship no MAC by default per sources found, Secure Boot is a manual sbctl job, and the AUR had major malware waves in Jul 2025 and Jun 2026.

### Cited Findings
- Fedora Workstation's default firewalld zone (FedoraWorkstation) opens TCP/UDP 1025-65535; a KDE SIG ticket says the KDE edition ended up with the same rules. — [Fedora Magazine](https://fedoramagazine.org/control-the-firewall-at-the-command-line/); [Fedora KDE SIG #435](https://pagure.io/fedora-kde/SIG/issue/435); [Unix SE archive](https://wiki.neonvagabond.xyz/content/unix.stackexchange.com_en_all_2024-05/questions/443261/which-ports-does-the-default-firewall-allow-on-fedora-workstation-and-fedora-s)
- Fedora NVIDIA + Secure Boot: akmods signs modules with a machine-local key that you enroll once with mokutil. — [Fedora MOK quick doc](https://docs.fedoraproject.org/gl/quick-docs/mok-enrollment/); [LinuxCapable F44](https://linuxcapable.com/how-to-install-nvidia-drivers-on-fedora-linux)
- CachyOS Secure Boot: manual — set firmware to setup mode, install sbctl, create and enroll keys; sbctl pacman hook signs kernels; systemd-boot updates need manual signing. Users report "Secure Boot Violation" on Limine, fixed by re-signing BOOTX64.EFI; some laptops need `--microsoft`. — [CachyOS wiki Secure Boot](https://wiki.cachyos.org/ko/configuration/secure_boot_setup); [CachyOS forum](https://discuss.cachyos.org/t/need-help-with-secure-boot-secure-boot-violation/15491); [CachyOS forum Limine SB](https://discuss.cachyos.org/t/limine-and-secure-boot-step-by-step-instructions/32468)
- No official statement found that CachyOS enables ufw or AppArmor by default; a third-party guide adds both by hand. — [Hardening CachyOS](https://www.woodcentral.com/-/peter/hardening-cachyos/)
- AUR Jul 2025: user "danikpapas" uploaded librewolf-fix-bin, firefox-patch-bin, zen-browser-patched-bin carrying CHAOS RAT; Arch notice 18 Jul 2025. — [ItsFOSS](https://itsfoss.com/news/arch-linux-chaos-rat/); [BleepingComputer](https://bleepingcomputer.com/news/security/fake-arch-linux-packages-push-malware-with-root-privileges)
- AUR Jun 2026: large campaign altering PKGBUILD build scripts, Rust credential stealer and eBPF rootkit; counts conflict (400+ per The Hacker News; ~1,500-1,579 per Phoronix/FOSSLinux/Privacy Guides); second, more obfuscated wave a day later; Arch disabled AUR package adoption (FOSSLinux dates it 30 Jul). — [The Hacker News](https://thehackernews.com/2026/06/400-arch-linux-aur-packages-hijacked-to.html); [Phoronix](https://phoronix.com/news/arch-linux-aur-more-malware); [Privacy Guides](https://www.privacyguides.org/news/2026/06/12/around-1-500-aur-packages-compromised-with-rootkit-like-malware.md); [FOSSLinux](https://www.fosslinux.com/159893/arch-linux-aur-malware-security-crisis.htm)
- FOSSLinux counts seven AUR malware incidents in twelve months. — [FOSSLinux](https://www.fosslinux.com/159893/arch-linux-aur-malware-security-crisis.htm)
- Arch posted php and ca-certificates security updates 2026-10-21 (rolling distros get fixes as soon as packaged). — [Arch news](https://archlinux.org/news/)

### Inferences
- The AUR risk is a usage risk, not a CachyOS-repo risk: CachyOS's own repos are signed and built by the team. Staying out of the AUR (or reading every PKGBUILD) removes most of it. Fedora's COPR has a similar but smaller-reported risk.
- Fedora's open 1025-65535 range is weaker than its reputation; switch the zone to `public` for a tighter default.
- SELinux enforcing on Fedora is well known; I did not fetch a 2026 primary source for it.

### Gaps
- No measured security-update latency comparison (Fedora vs Arch/CachyOS) found.
- CachyOS package signing details and repo infrastructure security not documented in sources found.

## Corporate backing and longevity (bus factor)

### Takeaway
Fedora (Red Hat-backed, ~13-month support per release, decades of history) and Debian (community, 5-10 years) have the lowest bus-factor risk. CachyOS is a small team led by Peter Jung, funded by donations and Framework (~850 USD/month since Oct 2026), with a stated goal of going full-time. Bazzite has Universal Blue and the Open Gaming Collective. Nobara is essentially one maintainer.

### Cited Findings
- Framework tripled CachyOS support to ~850 USD/month (from 250) on 14 Oct 2026, for build servers, mirrors and performance work; team hopes to move toward full-time work. — [Phoronix](https://phoronix.com/news/Framework-More-CachyOS); [GamingOnLinux](https://www.gamingonlinux.com/2026/10/framework-expands-funding-support-for-cachyos-linux/); [CachyOS forum](https://discuss.cachyos.org/t/announcement-framework-is-tripling-its-support-for-cachyos/37042)
- CachyOS founder/lead: Peter Jung (ptr1337); funding via Patreon and crypto donations. — [GamingOnLinux Jan 2026](https://gamingonlinux.com/2026/01/cachyos-founder-explains-why-they-didn-t-join-the-new-open-gaming-collective-ogc); [CachyOS donation wiki](https://wiki.cachyos.org/pl/support/donation/)
- Nobara: independent, led by Thomas "GloriousEggroll" Crider, no affiliation with Fedora/Red Hat. — [tech-insider](https://tech-insider.org/bazzite-vs-nobara-2026/)
- Bazzite: Universal Blue community on Fedora Atomic; Jan 2026 Open Gaming Collective formed (Bazzite, Universal Blue, Nobara, ChimeraOS, PikaOS...); CachyOS declined to join. Oct 2026 forum post: ~100K weekly active devices. — [GamingOnLinux OGC](https://www.gamingonlinux.com/2026/01/open-gaming-collective-ogc-formed-to-push-linux-gaming-even-further); [Universal Blue forum](https://universal-blue.discourse.group/t/bazzite-keeps-moving-312-commits-later-and-nearly-100k-weekly-active-devices/12562.md)
- Nobara release state conflicts across sources (Nobara 44 on 28 Aug 2026 vs still on F43 in mid-2026 comparisons). — [linuxcompatible](https://www.linuxcompatible.org/story/nobara-linux-44-refreshes-steam-htpc-and-handheld-images-with-20260926-build/)

### Inferences
- If CachyOS stopped, an install could fall back to plain Arch repos (it is Arch-based), so the exit path is softer than for Nobara.
- Nobara lags Fedora by weeks to months and depends on one person; it is the weakest choice for "solid for years".

### Gaps
- No team-size number for CachyOS found.
- No figures for Fedora's paid staff or Red Hat's 2026 commitment to Fedora desktop found.

## Changelog
- 2026-11-20 11:13 CET: Created research notes.
