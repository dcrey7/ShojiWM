---
title: Distro choice for an NVIDIA training and gaming desktop (Nov 2026)
date: 2026-11-20 11:15 CET
author: Claude (research report writer)
type: research-report
status: frozen
---

# Keep CachyOS, but rebuild it on snapshots

**Stay on CachyOS, but reinstall it on Btrfs with boot-menu snapshots.** Your real weak point today is not the distro. It is the ext4 disk with no snapshots, so a bad update has no fast undo. Fedora KDE can do everything you need. It runs NVIDIA training with uv and PyTorch wheels, it runs Steam and Proton, and it can host plasmashell with AeroThemePlasma and the SevenStart orb under ShojiWM. But Fedora gives you no gain in speed. It gives you stronger security defaults and slower, batched changes. In exchange, you lose first-class packages for your custom desktop and you must build snapshot tooling by hand. CachyOS ships boot-menu snapshots out of the box on Btrfs, and both AeroThemePlasma and ShojiWM treat Arch (the base of CachyOS) as their main target. Fedora KDE 45 is a sound second choice if security defaults and calm updates matter more to you than first-class customization. Bazzite, Nobara, NixOS and Debian 13 each fail one of your hard needs.

A few words first, because the rest of the report uses them. A **rolling release** distro (CachyOS, Arch) sends you every new version as soon as it is ready, in small daily steps. A **point release** distro (Fedora, Debian) freezes a set of versions and ships a new set on a fixed date. A **snapshot** is a frozen copy of the system files at one moment; if an update breaks the system, you boot the copy and you are back in minutes. An **atomic** (or immutable) distro (Bazzite, Kinoite, NixOS) swaps the whole system image at once and keeps the old image, so a rollback is always one reboot away.

```
 bad update
     |
     v
 ext4, no snapshot (you today) --> live USB, chroot, manual repair (hours)
 Btrfs + snapper + Limine      --> pick old snapshot in boot menu (minutes)
 atomic (Bazzite, NixOS)       --> pick old image in boot menu (minutes)
```

## Both distros run your RTX 3090 for training and gaming

Your first doubt was whether Fedora can do NVIDIA training and gaming. The answer is yes, with no catch for an RTX 3090. Fedora installs the NVIDIA driver from RPM Fusion, a community repository that sits next to Fedora's own. The package is called `akmod-nvidia`. An **akmod** is a recipe that builds the NVIDIA kernel module on your own machine after each kernel update; the build takes **up to 5 minutes** ([RPM Fusion](https://rpmfusion.org/Howto/NVIDIA)). Fedora 44 got driver **620.70.06 on 5 Nov 2026**, and CachyOS got the same version on 7 Nov ([RPM Fusion F44](https://download1.rpmfusion.org/nonfree/fedora/updates/44/x86_64/repoview/akmod-nvidia.html); [CachyOS packages](https://packages.cachyos.org/package/cachyos-v3/x86_64_v3/nvidia-utils)). So the driver lag between the two is about two days.

For training, the distro matters even less. PyTorch wheels from pip or uv carry their own CUDA runtime, cuDNN and cuBLAS. Your system only supplies the kernel driver and `libcuda.so`. Since **PyTorch 2.11 (March 2026)**, a plain `pip install torch` on Linux pulls **CUDA 13.0 wheels** ([PyTorch dev-discuss](https://dev-discuss.pytorch.org/t/transitioning-pypi-cuda-wheels-to-cuda-13-0-as-the-stable-release-2-11/3325)). CUDA 13.x needs driver branch **R580 or newer** ([NVIDIA CUDA release notes](https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html)). Your pinned 580.178.04 meets that, and so does any current Fedora or CachyOS driver. You need a full system CUDA toolkit only when you compile custom CUDA code, such as flash-attn from source.

The real driver difference is how each distro breaks. On Fedora, the common failure is timing: the new kernel arrives, you reboot before the akmod build ends, and you get a black screen. Fedora forum threads show this pattern through 2026, from kernel 6.18 up to 7.2.6 ([Fedora Discussion, 7.2.6](https://discussion.fedoraproject.org/t/fedora-44-kernel-7-2-6-wont-boot/202667); [Fedora Discussion, 6.18.10](https://discussion.fedoraproject.org/t/blackscreen-after-upgrade-to-6-18-10-200/181781)). The fix is to boot the previous kernel, which Fedora keeps in the boot menu. CachyOS ships the module prebuilt for each CachyOS kernel, so there is no local build. Its failure is a version mismatch: the repo has the new driver but not the matching piece, and the update stops. CachyOS threads show this in **Aug, Sep, Oct and Nov 2026** ([CachyOS forum, 610.57](https://discuss.cachyos.org/t/cachyos-v4-nvidia-610-57-04-1-update-broken/33847); [CachyOS forum, 620](https://discuss.cachyos.org/t/nvidia-driver-620-update-breaks-graphics/38920)). Nobody has counted breakages per distro, so these thread samples show the kind of failure, not the rate.

Gaming speed is close to equal. Phoronix found CachyOS **about 4% ahead** of Fedora 44 on CPU-heavy tests in April 2026, and then **Fedora 45 ahead** on the overall mean in October 2026 ([Phoronix, Apr](https://www.phoronix.com/review/cachyos-ubuntu-2604-fedora-44/6); [Phoronix, Oct](https://www.phoronix.com/review/cachyos-ubuntu2610-fedora45)). Those are CPU suites, not games. No controlled 2026 test compares the two on NVIDIA in games. CachyOS's own wiki says to expect modest gains ([CachyOS wiki](https://wiki.cachyos.org/configuration/gaming/)). The NVIDIA DirectX 12 gap against Windows, estimated at **about 18%** by one forum user, is much larger than any distro gap and hits every distro the same ([NVIDIA forum](https://forums.developer.nvidia.com/t/directx12-performance-is-terrible-on-linux/303207?page=37)). Anti-cheat is per game, not per distro: Fortnite, Valorant and Warzone do not run on any Linux ([GamingOnLinux](https://www.gamingonlinux.com/guides/view/anticheat-check-which-competitive-games-actually-work-on-linux-steamos/)).

One note on your 580 pin. It is safe for PyTorch. But you miss gaming fixes from the 615 branch, such as better latency with frame generation in VKD3D-Proton ([Phoronix](https://www.phoronix.com/news/NVIDIA-615.78.08-Linux)). Your GPU crashes were fixed by the 1800 MHz clock cap, so the pin may no longer be needed. Test a newer branch only after you have snapshots, because the first 620 builds had reports of crashes and bad colour on CachyOS ([CachyOS forum](https://discuss.cachyos.org/t/nvidia-driver-620-update-breaks-graphics/38920)).

## Your taskbar works on both, but Arch is the first-class home

Your second doubt was whether Fedora can keep this taskbar and desktop. The answer is yes, with more manual work. Today Fedora 44 and 45 ship **Plasma 6.8.3**, the same version as Arch ([Fedora packages](https://packages.fedoraproject.org/pkgs/plasma-workspace/plasma-workspace/); [Arch packages](https://archlinux.org/packages/?q=plasma-workspace)). Fedora is about one Qt step behind (6.11 against 6.12) ([Fedora packages](https://packages.fedoraproject.org/pkgs/qt6-qtbase/qt6-qtbase/)). Fedora also ships new Plasma releases inside a running release, so you do not wait six months for them ([Bodhi](https://bodhi.fedoraproject.org/updates/FEDORA-2025-504ad1c52a)).

The plasmashell-under-ShojiWM part does not depend on the distro. KDE does not support plasmashell on other compositors and tests it only on KWin ([KDE mailing list](https://mail.kde.org/pipermail/kde/2024-January/029995.html)). ShojiWM fills that gap itself, because it speaks the KDE protocols that plasmashell needs. So the same setup that works on CachyOS works on Fedora. The one config change is the path of `kglobalacceld`: ShojiWM's own docs say Arch puts it in `/usr/lib` and other distros may use `/usr/libexec`.

The difference is packaging. AeroThemePlasma ships **AUR packages for Arch** as its main route. On Fedora, you build it from source with a dependency list that contributors keep, and the install guide says these lists "aren't updated frequently" ([wackyideas blog](https://wackyideas.neocities.org/blogposts/2026/03/01/aerothemeplasma-new-version); [ATP INSTALL](https://gitdab.com/Cynosphere/aerothemeplasma/raw/branch/Plasma/6.7/INSTALL.md)). ShojiWM documents build dependencies for Arch and Debian, not Fedora, though every dependency exists in Fedora's repos ([ShojiWM install docs](https://bea4dev.github.io/ShojiWM/docs/getting-started/installation)). Other Smithay compositors prove the toolchain works there: niri is in official Fedora repos ([Fedora packages](https://packages.fedoraproject.org/pkgs/niri/niri/)).

The fragile piece on every distro is the same. AeroThemePlasma replaces `libplasma` with its own fork. Each Plasma update can break it until you re-run the install script for the matching branch ([ATP INSTALL](https://gitdab.com/Cynosphere/aerothemeplasma/raw/branch/Plasma/6.7/INSTALL.md)). A fast distro brings this break sooner. So on CachyOS you hold Plasma with `IgnorePkg` until the matching AeroThemePlasma branch is ready, as you already do with 6.7.5. On Fedora you would use `dnf versionlock` for the same job.

## Snapshots are the gap, and CachyOS fills it for free

Recovery speed is where your current setup is weakest, and where the distros differ most. CachyOS on Btrfs takes a snapshot before and after every pacman update, and the **Limine** boot menu lists those snapshots so you can boot one directly. Limine has been the installer default **since January 2026** ([CachyOS Jan 2026 release](https://cachyos.org/blog/2601-january-release/); [CachyOS wiki](https://wiki.cachyos.org/configuration/btrfs_snapshots/)). Fedora KDE also uses Btrfs, but it ships no snapshot tooling. You add snapper, a DNF5 hook and grub-btrfs from a COPR by hand, and Fedora users in 2026 still ask for help with it ([Fedora Discussion guide](https://discussion.fedoraproject.org/t/btrfs-snapshots-in-fedora-the-definitive-step-by-step-easy-and-safe-guide/194483); [Fedora Discussion](https://discussion.fedoraproject.org/t/difficult-to-enable-btrfs-snapshots/200470)).

Snapshots have limits on both. The CachyOS wiki warns that a snapshot that spans a kernel update may not roll back ([CachyOS wiki](https://wiki.cachyos.org/configuration/btrfs_snapshots/)). Snapshots stop when the boot partition passes **85%** full ([CachyOS forum](https://discuss.cachyos.org/t/limine-btrfs-snapshots-stopped-being-added-to-bootloader-snapper/20388)). And the default setup covers `/` only, not `/home`, where your KDE and ShojiWM config live. That is why the plan below keeps the LTS kernel as a second exit and backs up `~/.config` on its own.

Over years, the two models feel different. Fedora supports each release for **about 13 months** and asks for a major upgrade every six months, or every year if you skip one ([Fedora lifecycle](https://fedoraproject.org/wiki/User:Jkurik/Fedora_Release_Life_Cycle.diff); [Neowin](https://www.neowin.net/news/fedora-42-is-officially-dead-and-you-need-to-upgrade-your-pc-right-now/)). Each upgrade is a "big day" that can break the driver: the Fedora 43 to 44 jump broke older NVIDIA cards ([Fedora Discussion](https://discussion.fedoraproject.org/t/upgrading-to-fedora-44-breaks-nvidia-driver-for-older-gpus-geforce-10xx-and-older/192286)). CachyOS has no big day, only many small ones. Neither is clearly more stable; they spread the risk differently.

## Fedora wins on security defaults; CachyOS needs discipline

Fedora ships **SELinux** in enforcing mode. SELinux is a kernel guard that limits what each program may touch, even when it runs as root. Fedora also turns on a firewall, and Secure Boot works from day one; the NVIDIA akmod needs a one-time key enrollment ([Fedora MOK docs](https://docs.fedoraproject.org/gl/quick-docs/mok-enrollment/)). Fedora's default desktop firewall zone still leaves ports 1025 to 65535 open, so it is weaker than its reputation ([Fedora Magazine](https://fedoramagazine.org/control-the-firewall-at-the-command-line/)). CachyOS ships no such guard by default per the sources found, and Secure Boot is a manual job with `sbctl` ([CachyOS wiki](https://wiki.cachyos.org/ko/configuration/secure_boot_setup); [Hardening CachyOS](https://www.woodcentral.com/-/peter/hardening-cachyos/)).

The largest risk on CachyOS is the **AUR**, the Arch User Repository, where anyone can upload a build script. In **June 2026**, an attack altered hundreds of AUR packages to install a credential stealer and a rootkit; counts range from **400 to about 1,500** ([The Hacker News](https://thehackernews.com/2026/06/400-arch-linux-aur-packages-hijacked-to.html); [Privacy Guides](https://www.privacyguides.org/news/2026/06/12/around-1-500-aur-packages-compromised-with-rootkit-like-malware.md)). CachyOS's own repos are separate and signed. So the rule is simple: use the AUR only for AeroThemePlasma, and read each build script before you install.

Longevity favours Fedora. Red Hat backs it. CachyOS is a small team led by Peter Jung, funded by donations and by Framework at **about 850 USD per month** since October 2026 ([Phoronix](https://phoronix.com/news/Framework-More-CachyOS)). If CachyOS stopped, you could fall back to plain Arch repos, so the exit path is soft.

## Keeping and evolving this exact setup favours Arch-based systems

Your setup is more than a taskbar. It is ShojiWM built from source, your TypeScript config (start menu launcher, Magic Lamp, frosted glass, traffic lights, tiling and workspaces, Coverflow), the Plasma pieces under it, and your helper scripts and services. You also want to keep changing it for years and rebuild ShojiWM often. So the test is: how cheap is each rebuild, how often does an update break it, and how easily does it move to your laptop.

**Rebuilding ShojiWM.** ShojiWM ships no distro packages yet; AUR packages are "planned for just before the official release" ([ShojiWM install docs](https://bea4dev.github.io/ShojiWM/docs/getting-started/installation)). You build it with `./dist/install.sh`, which compiles it and copies the compositor, the TypeScript runtime and the session file into `/usr` with `sudo` ([ShojiWM install docs](https://bea4dev.github.io/ShojiWM/docs/getting-started/installation)). The docs list Arch package names for every dependency, and the V8 engine for your TypeScript config is built in, so you install no Deno. On CachyOS that is one documented `pacman` line and a current Rust (1.99 on your machine today). On Fedora every dependency exists, but you translate the package names yourself, and Fedora's packaged Rust tends to trail upstream, so you would use `rustup` instead. That is a one-time cost, then rebuilds are the same `cargo` build on both. On Bazzite or Kinoite the installer fails, because `/usr` is read-only; each rebuild becomes an RPM layer or a new system image. On NixOS you rebuild through the experimental flake module that ShojiWM ships.

**Surviving distro updates.** Three things move under your setup. Plasma minor releases break the AeroThemePlasma libplasma fork until you re-run its install script for the matching branch ([ATP INSTALL](https://gitdab.com/Cynosphere/aerothemeplasma/raw/branch/Plasma/6.7/INSTALL.md)). Rust and Mesa updates can change how ShojiWM builds or renders; both Arch and Fedora 44/45 ship Mesa 26.2.x today ([Fedora packages](https://packages.fedoraproject.org/pkgs/mesa/mesa-dri-drivers/)). On CachyOS these changes arrive one at a time, you can hold any of them with `IgnorePkg`, and a snapshot undoes a bad one. On Fedora they arrive in batches, with a large batch at each six-month upgrade, and AeroThemePlasma's Fedora dependency list may lag that upgrade. AeroThemePlasma already had a Plasma 6.8 branch on **8 Nov 2026**, and its newest branch commit was an openSUSE dependency fix, which shows that non-Arch lists get fixed after the fact ([gitdab branches](https://gitdab.com/Cynosphere/aerothemeplasma/branches)).

**Moving to another machine.** Your laptop already runs CachyOS with ShojiWM. On the same distro, a move is: install the same package list, run the same build, copy the same config. A second distro on one of the two machines would double the work: two dependency lists, two library paths, and two sets of breakages to track. NixOS is the strongest in theory, because one flake file describes the whole system and rebuilds it the same way on both machines. But its ShojiWM module is experimental, AeroThemePlasma's NixOS support is still "in progress", and PyTorch wheels need extra glue ([wackyideas blog](https://wackyideas.neocities.org/blogposts/2026/03/01/aerothemeplasma-new-version); [NixOS Discourse](https://discourse.nixos.org/t/python-uv-nix-ld-runtimeerror-found-no-nvidia-driver-on-your-system/71503)). A custom Bazzite image is also portable, since both machines can boot the same image, but every change waits for an image build.

**Config as files.** Your ShojiWM TypeScript config, Plasma settings, AeroThemePlasma themes and user services live in your home folder as plain files. They move to any distro unchanged. The only distro-specific line in your setup is the `kglobalacceld` path: `/usr/lib` on Arch, likely `/usr/libexec` on Fedora (ShojiWM's own docs flag this). Put the config, the helper scripts, the systemd user units and a package list in one git repo, and the same repo rebuilds both machines.

| Distro | Rebuild ShojiWM | Survive updates | Move to laptop | Config as files |
|---|---|---|---|---|
| CachyOS | Easy: documented deps, current Rust | Good: hold any package, snapshot undo | Easiest: laptop runs it already | Yes |
| Arch | Easy: same as CachyOS | Good if you add snapshots yourself | Easy | Yes |
| Fedora KDE | Medium: translate deps, use rustup | Medium: batched jumps, ATP Fedora list lags | Medium: laptop must move too | Yes, one path change |
| Nobara | Medium: Fedora plus extra patches | Weaker: small team, lags Fedora | Medium | Yes |
| NixOS | Medium to hard: experimental module | Strong rollback, slow Plasma (6.6.x) | Strong in theory: one flake | Yes, as Nix code |
| Bazzite | Hard: image rebuild per change | Strong rollback, but rebuild per Plasma bump | Good: same image | Yes |
| Debian 13 | Medium | Poor: Plasma 6.3.6 too old for ATP | Medium | Yes |

## The other five each fail one hard need

| Distro | Main strength | Why it does not fit you |
|---|---|---|
| Arch | Same packages as CachyOS, same AeroThemePlasma route | No snapshot setup, no tuned kernel or gaming meta packages; you build what CachyOS gives you |
| Bazzite | Atomic rollback, NVIDIA driver built into the image, ~100K weekly devices ([Universal Blue forum](https://universal-blue.discourse.group/t/bazzite-keeps-moving-312-commits-later-and-nearly-100k-weekly-active-devices/12562.md)) | Read-only `/usr`: ShojiWM's installer and the libplasma fork need a custom image rebuild for each change ([Bazzite FAQ](https://docs.bazzite.gg/General/FAQ/)) |
| Nobara | Fedora plus CachyOS kernel plus gaming tools | Mostly one maintainer; Secure Boot must be off for new installs ([PCGH](https://www.pcgameshardware.de/Linux-Software-26761/News/Nobara-44-streicht-Nvidia-Image-1552510/)) |
| NixOS | Best rollback: every old system stays in the boot menu ([NixOS wiki](https://wiki.nixos.org/wiki/Nixos-rebuild)) | uv PyTorch wheels cannot find `libcuda.so` without extra glue ([NixOS Discourse](https://discourse.nixos.org/t/python-uv-nix-ld-runtimeerror-found-no-nvidia-driver-on-your-system/71503)); ShojiWM module is experimental |
| Debian 13 | Five years of calm support ([Debian](https://www.debian.org/releases/trixie/)) | Plasma frozen at 6.3.6, too old for AeroThemePlasma; stock NVIDIA 550 cannot run default CUDA 13 wheels ([Debian NEW](https://ftp-master.debian.org/new/nvidia-graphics-drivers_550.163.01-4~bpo13+1.html)) |

## Conclusion

The question "which distro" turned out to be smaller than the question "which disk layout". A heavily customized desktop with a from-source compositor and a forked libplasma will break now and then on any mutable distro, because the parts move at KDE's pace, not the distro's. What you can choose is how cheap each break is. On CachyOS with Btrfs, Limine snapshots, a held Plasma version and the LTS kernel as backup, a break costs minutes. On today's ext4 install, it costs a live USB and an evening. The deciding factor is that you want to keep this exact setup and keep changing it for years, on two machines. CachyOS is the only option where both machines already run it, every ShojiWM dependency is documented, AeroThemePlasma is packaged first, and each update can be held or undone on its own. Fedora would trade that for better security defaults, would still need the snapshot work done by hand, and would force a second migration on the laptop. Pick Fedora KDE 45 only if you decide that SELinux and Red Hat backing outweigh all of that. Revisit NixOS once ShojiWM's module is no longer experimental, because one file that rebuilds both machines is the best long-term answer to your portability need.

The next steps, in order:

1. Back up `/home`, `~/.config`, `~/.local/share`, the ShojiWM config and your uv projects to another disk.
2. Put the ShojiWM TypeScript config, helper scripts, systemd user units, Plasma settings and a package list into one git repo. Use it to rebuild the PC first, then the laptop.
3. Write down your held packages and the 580xx pin (`pacman -Qe`, the `IgnorePkg` line in `/etc/pacman.conf`).
4. Reinstall CachyOS with Btrfs and the Limine bootloader. Keep the 4 GB boot partition the installer proposes.
5. Install both `linux-cachyos` and `linux-cachyos-lts`, and the matching NVIDIA module for each.
6. Hold Plasma and the NVIDIA packages as a set with `IgnorePkg`. Lift the hold only when AeroThemePlasma has a branch for the new Plasma.
7. Rebuild ShojiWM and AeroThemePlasma. Read every AUR build script before you install it.
8. Add a second backup for `/home` (for example Timeshift or Borg to another disk), because snapper covers `/` only.
9. Turn on `ufw`, and set up Secure Boot with `sbctl` if you want it.
10. With snapshots in place, test the 615 branch on one boot. Roll back from the Limine menu if it fails. Keep your 1800 MHz clock cap.
11. Until the reinstall, take a Timeshift rsync snapshot of today's ext4 system to another disk, so you have a fallback now.

## Changelog

- 2026-11-20 11:15 CET: Created the report from four research notes (NVIDIA and CUDA, gaming, KDE and ShojiWM, stability and security).
- 2026-11-20 11:20 CET: Added the section on keeping and evolving the whole setup (rebuild, updates, laptop move, config as files) and weighed it in the recommendation.
