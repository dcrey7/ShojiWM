# NVIDIA driver and CUDA/PyTorch setup on Linux desktops (RTX 3090, Nov 2026)

Notes written 2026-11-20 11:13 CET. Scope: one RTX 3090 (Ampere, sm_86) that drives a Wayland KDE desktop and also runs daily PyTorch training (uv + PyTorch CUDA wheels).

Local fact from this machine (checked with `pacman -Q` and `nvidia-smi` on 2026-11-20): CachyOS, kernels `linux-cachyos 7.2.9-2` and `linux-cachyos-lts 6.18.55-2`, driver `nvidia-580xx-dkms 580.178.04-1` (a deliberate pin to the 580 branch, not the CachyOS default). No web source; this is a direct measurement.

## Fedora: how the driver is installed in 2026 and how often kernel updates break it

### Takeaway
Fedora still uses RPM Fusion `akmod-nvidia` (local build after each kernel update, about 2-5 min). The open kernel module is now the default variant. Fedora 44 is on the newest branch (620.70.06, 5 Nov 2026); Fedora 43 stays on the 580 legacy branch (580.196.07). Kernel-update breakage is real and recurring in 2026 forum threads, mostly "rebooted before akmods finished" or "akmod failed to build on a brand-new kernel".

### Cited Findings
- Install command: `sudo dnf install akmod-nvidia` after enabling RPM Fusion free + nonfree; optional `xorg-x11-drv-nvidia-cuda` for CUDA/NVENC/NVDEC. Update the system and reboot into the latest kernel first. — [RPM Fusion Howto/NVIDIA (last edited 2026-11-14)](https://rpmfusion.org/Howto/NVIDIA)
- "The 595+ driver is available by default on Fedora 44+" and dropped GPUs older than Pascal; the legacy 580xx branch uses `xorg-x11-drv-nvidia-580xx-cuda` (CUDA up to 12.x). — [RPM Fusion Howto/NVIDIA](https://rpmfusion.org/Howto/NVIDIA)
- Open kernel module is the default variant; to go back to the proprietary module on old cards set `%_without_kmod_nvidia_detect 1` in `/etc/rpm/macros.nvidia-kmod` and run `akmods --kernels $(uname -r) --rebuild`. The full-source `akmod-nvidia-open` sits in the tainted repo and is not recommended. — [RPM Fusion Howto/NVIDIA](https://rpmfusion.org/Howto/NVIDIA) (note: my summary tool reported "kmod-nvidia ships a prebuilt open module"; verify the exact wording on the page)
- Older (2025) workaround to force the open variant: `echo "%_with_kmod_nvidia_open 1" | sudo tee -a /etc/rpm/macros.nvidia-kmod`, then reinstall. — [idroot F43 guide](https://idroot.us/install-nvidia-drivers-fedora-43) (third-party guide)
- Wait for the build: "can take up to 5 minutes"; check with `modinfo -F version nvidia`. — [RPM Fusion Howto/NVIDIA](https://rpmfusion.org/Howto/NVIDIA)
- Secure Boot: create and import your own key *before* installing the kmod, else blank screen; field report gives `kmodgenca -a && mokutil --import /etc/pki/akmods/certs/public_key.der`. — [RPM Fusion Howto/NVIDIA](https://rpmfusion.org/Howto/NVIDIA); [falcao.org field report, 19 May 2026](https://falcao.org/posts/nvidia-fedora-kde-wayland/)
- Current versions: F44 `akmod-nvidia 620.70.06-1.fc44` (changelog 2026-11-05); F43 `akmod-nvidia 580.196.07-1.fc43` (changelog 2026-11-09). — [RPM Fusion F44 repoview](https://download1.rpmfusion.org/nonfree/fedora/updates/44/x86_64/repoview/akmod-nvidia.html); [RPM Fusion F43 repoview](https://download1.rpmfusion.org/nonfree/fedora/updates/43/x86_64/repoview/akmod-nvidia.html)
- Earlier F43 builds: 580.119.02 (Dec 2025), 580.178.04 (5 Aug 2026). — [mirror F43 akmod-nvidia-open](https://debian.rub.de/rpmfusion/nonfree/fedora/updates/testing/43/x86_64/repoview/akmod-nvidia-open.html); [mirror F43 akmod-nvidia](https://debian.rub.de/rpmfusion/nonfree/fedora/updates/43/x86_64/repoview/akmod-nvidia.html)
- Positive 2026 field report (F44, KDE Plasma 6.6, RTX 5070, driver 595.71.05): akmods rebuilds on each new kernel, "maintenance effectively zero"; one known issue: s2idle resume hang on kernel 7.0 + Blackwell (open-gpu-kernel-modules #1117). — [falcao.org, 19 May 2026](https://falcao.org/posts/nvidia-fedora-kde-wayland/)
- 2026 breakage reports on Fedora Discussion:
  - black screen with cursor after login on kernel 6.18.10 (fix: rebuild akmods) — [thread](https://discussion.fedoraproject.org/t/blackscreen-after-upgrade-to-6-18-10-200/181781); [boot failure 6.18.7 to 6.18.10](https://discussion.fedoraproject.org/t/boot-failure-after-kernel-update-from-6-18-7-200-fc43-to-6-18-10-200-fc43/181501)
  - KDE black screen after kernel 6.18.6 — [thread](https://discussion.fedoraproject.org/t/kde-boots-to-black-screen-after-updating-to-kernel-6-18-6-200/180120)
  - boot freeze on F43 KDE 6.19.9 after NVIDIA update — [thread](https://discussion.fedoraproject.org/t/fedora-43-kde-6-19-9-200-boot-freeze-after-nvidia-driver-updates/184736)
  - drivers "not driving" on 6.19.13 — [thread](https://discussion.fedoraproject.org/t/f43-kernal-6-19-13-nvidia-drivers-not-driving/189517)
  - RTX 4070 black screen on kernel 7.1.4 — [thread](https://discussion.fedoraproject.org/t/latest-update-kernel-7-1-4-nvidia-4070-black-screen/197473)
  - F44 kernel 7.2.6 won't boot; user fixed it by updating kernel and driver in separate steps and waiting for akmods each time — [thread](https://discussion.fedoraproject.org/t/fedora-44-kernel-7-2-6-wont-boot/202667)
  - F44 upgrade breaks GTX 10xx and older (not relevant to a 3090) — [Common Issue thread](https://discussion.fedoraproject.org/t/common-issue-talk-upgrading-to-fedora-44-breaks-nvidia-driver-for-older-gpus-geforce-10xx-and-older/192378)
- Standard recovery: Ctrl+Alt+F3, `sudo akmods --force --rebuild --kernels <ver>`, check `/var/cache/akmods/nvidia/.last.log`. — [search summary of the threads above](https://discussion.fedoraproject.org/tag/akmods/1044)

### Inferences
- The main Fedora risk is timing: the new kernel lands at the same time as the build, and a reboot before akmods finishes boots Nouveau or a black screen. Keeping the previous kernel in GRUB (Fedora keeps 3) gives a one-step fallback.
- Fedora 43 users on the default RPM Fusion branch get CUDA 13.0-level drivers (580); Fedora 44 users get 620 (CUDA 13.5 level). Both are new enough for every current PyTorch wheel.
- Fedora 43 reaches end of life around one month after Fedora 45 releases; a new install in Nov 2026 should be Fedora 44 (or 45 if out).

### Gaps
- I did not find an official 2026 Fedora change that moves NVIDIA out of RPM Fusion (for example a Fedora-hosted NVIDIA repo enabled by the "third-party repositories" toggle). The GNOME/KDE third-party toggle historically enabled an RPM Fusion NVIDIA repo; I did not confirm its 2026 state.
- No quantitative breakage rate (for example "x % of kernel updates"). Only anecdotal thread counts.
- Fedora 45 release status and driver version not checked.

## CachyOS: how the driver ships, version lag, breakage 2025-2026

### Takeaway
CachyOS ships precompiled open modules per CachyOS kernel (`linux-cachyos-nvidia-open`, `linux-cachyos-lts-nvidia-open`, and so on) plus `nvidia-open-dkms`, with `chwd` picking the profile at install. Driver lag is near zero: `nvidia-utils 620.70.06` built 7 Nov 2026, the same branch Fedora 44 got on 5 Nov. Breakage in 2025-2026 is mostly packaging/dependency conflicts during branch transitions (580xx split Dec 2025, 610 and 615 updates in 2026), not module build failures.

### Cited Findings
- Dec 18, 2025 announcement: closed driver replaced by `nvidia-580xx-utils` as the base for Pascal and older; Turing+ should install `linux-cachyos-nvidia-open linux-cachyos-lts-nvidia-open nvidia-utils opencl-nvidia lib32-nvidia-utils lib32-opencl-nvidia nvidia-settings`; module package must match the kernel name (e.g. `linux-cachyos-bore-nvidia-open`). — [CachyOS forum announcement](https://discuss.cachyos.org/t/announcement-maintenance-notice-nvidia-driver-restructuring-580xx-590xx/20010)
- Replies reported: `nvidia-libgl` conflict, installer "target not found: nvidia-580xx-settings" (fixed after mirror sync, 10-20 min), unresolvable conflict on RTX 5070 and RTX 4080 between `nvidia-580xx-dkms` and `linux-cachyos-nvidia-open`. — [same thread](https://discuss.cachyos.org/t/announcement-maintenance-notice-nvidia-driver-restructuring-580xx-590xx/20010)
- Arch upstream (590): main `nvidia` package replaced by `nvidia-open`; Pascal and older dropped. — [Arch news](https://archlinux.org/news/nvidia-590-driver-drops-pascal-support-main-packages-switch-to-open-kernel-modules/)
- Current version: `nvidia-utils 620.70.06-2`, built 7 Nov 2026 (cachyos-v3 repo). — [packages.cachyos.org](https://packages.cachyos.org/package/cachyos-v3/x86_64_v3/nvidia-utils)
- Precompiled per-kernel module example: `linux-cachyos-lts-lto-nvidia-open 6.12.69-2` depends on `nvidia-utils=590.48.01`, built 7 Feb 2026 (shows exact version pinning between module and utils). — [packages.cachyos.org](https://packages.cachyos.org/package/cachyos-v3/x86_64_v3/linux-cachyos-lts-lto-nvidia-open)
- CachyOS shipped 610.43.02, the first 610-branch release, early. — [PCGH](https://www.pcgameshardware.de/Linux-Software-26761/News/CachyOS-Nvidia-Treiber-HDR-Linux-Wayland-1538449/)
- 2026 breakage reports:
  - v4 repo 610.57.04 update missing matching `lib32-nvidia-utils` — [thread](https://discuss.cachyos.org/t/cachyos-v4-nvidia-610-57-04-1-update-broken/33847)
  - chwd fails: cannot resolve `nvidia-utils=610.57.04` (Sep 2026) — [thread](https://discuss.cachyos.org/t/error-installation-failed-failed-to-run-chwd/35807)
  - `nvidia-open-dkms 615.71.09` conflicts with `linux-cachyos-lts-nvidia-open 6.18.48`; advice: use DKMS so modules rebuild on each update — [thread](https://discuss.cachyos.org/t/updating-cachy-broke-my-display/36258?page=2)
  - boot to TTY after NVIDIA 615.71 + systemd 261.3 — [thread](https://discuss.cachyos.org/t/booting-straight-to-tty-after-recent-update-nvidia-615-71-systemd-261-3/35650)
  - chwd cannot install `nvidia-dkms-580xx` — [thread](https://discuss.cachyos.org/t/unable-to-install-nvidia-dkms-580xx-using-chwd/24022)
  - several 2026 "black screen" threads were AMD firmware (`linux-firmware-amdgpu 20260910`), not NVIDIA — [thread](https://discuss.cachyos.org/t/black-screen-after-update-linux-firmware-amdgpu-1-20260910-1-on-radeon-680m/35988)

### Inferences
- Precompiled modules avoid the Fedora "reboot before build" problem, but trade it for strict version lockstep: if the repo has a new `nvidia-utils` but not the matching module for your kernel (or a v4 mirror lags), pacman refuses or the system boots without a module. DKMS avoids lockstep but builds locally like Fedora.
- Pinning to an older branch on CachyOS (as this machine does with `nvidia-580xx-dkms`) works, but it is off the default path and chwd support for it is shaky.
- Recovery on CachyOS is easier with the default btrfs + snapper snapshots (boot an older snapshot), but one 2026 thread shows snapshot restores failing too ([thread](https://discuss.cachyos.org/t/random-black-screen-on-boot-btrfs-restores-failed-now-stuck-in-chroot/33541)).

### Gaps
- No official CachyOS wiki page fetched; chwd profile names for Nov 2026 not verified.
- No count of breakage events per month; only thread samples.

## CUDA for PyTorch: system toolkit, driver minimums, awkward distros

### Takeaway
PyTorch pip/uv wheels bundle the CUDA runtime, cuDNN and cuBLAS as `nvidia-*` wheels; you need only the kernel driver plus `libcuda.so` from the distro. Since PyTorch 2.11 (Mar 2026) plain `pip install torch` on Linux pulls CUDA 13.0 wheels, which need driver branch R580 or newer. Any 580+ driver (Fedora 43/44, CachyOS, Arch, Bazzite) works; Debian 13's stock 550 driver does not run cu130 wheels, and NixOS needs extra glue for `libcuda.so`.

### Cited Findings
- PyTorch 2.11: CUDA 13.0 becomes the stable PyPI variant (x86_64 + aarch64); CUDA 12.6 and 12.8 remain on download.pytorch.org. Post dated 11 Mar 2026. — [PyTorch dev-discuss](https://dev-discuss.pytorch.org/t/transitioning-pypi-cuda-wheels-to-cuda-13-0-as-the-stable-release-2-11/3325)
- Users with only CUDA 12.x drivers may hit errors on plain `pip install torch` from 2.11 on; cu130 supports Turing (sm_75) and newer; cu126 is the route for Maxwell/Pascal/Volta. — [newreleases torch 2.11.0](https://newreleases.io/project/pypi/torch/release/2.11.0); [PyTorch 2.11 blog](https://pytorch.org/blog/pytorch-2.11-release/)
- CUDA 12.8 binaries removed from the build matrix in 2.12; CUDA 12.6 wheels stop at 2.15. — [newreleases torch 2.12.0](https://newreleases.io/project/pypi/torch/release/2.12.0); related-topic title on [dev-discuss](https://dev-discuss.pytorch.org/t/transitioning-pypi-cuda-wheels-to-cuda-13-0-as-the-stable-release-2-11/3325)
- PyTorch 2.14 publishes cu126, cu130, cu132 variants (single blog source). — [fullstack.com blog](https://www.fullstack.com/labs/resources/blog/cuda-13-4-update-1-what-early-adopters-are-hitting)
- NVIDIA driver/toolkit table: CUDA 13.0 = R580, 13.1 = R590, 13.2 = R595, 13.3 = R610, 13.4 = R615, 13.5 = R620. Minor-version compatibility: 13.x needs driver >= 580; 12.x needs >= 525. Full minimums: 12.6u3 >= 560.35.05, 12.8u1 >= 570.124.06, 12.9u1 >= 575.57.08. — [NVIDIA CUDA release notes](https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html)
- CUDA 13.0 exact minimums: GA >= 580.65.06, U1 >= 580.82.07, U2 >= 580.95.05 (secondary source). — [gpusmith PDF](https://gpusmith.com/articles/en/pdfs/cuda-compatibility-production-upgrade-gate.pdf)
- Linux CUDA toolkit no longer bundles the driver from 13.4. cuBLAS 13.5 notes still target "Ampere and newer", so Ampere stays supported; 13.0 dropped Maxwell/Pascal/Volta in cuFFT. — [NVIDIA CUDA release notes](https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html)
- uv supports PyTorch CUDA indexes; Astral also runs GPU wheel indexes. — [Astral GPU indexes](https://wheels.astral.sh/)
- Debian 13: stock `nvidia-driver` is the 550 branch (550.163.01); trixie-backports has only a 550.163.01 rebuild (Dec 2025); newer branches (590/595) need NVIDIA's CUDA apt repo. Open flavor of 550 failed to build on backports kernel 6.17. — [Debian NEW package](https://ftp-master.debian.org/new/nvidia-graphics-drivers_550.163.01-4~bpo13+1.html); [Debian tracker](https://tracker.debian.org/news/1699160/accepted-nvidia-open-gpu-kernel-modules-55016301-4bpo131-source-amd64-into-stable-backports/); [linuxcapable guide](https://linuxcapable.com/install-nvidia-drivers-on-debian/); [NVIDIA forum](https://forums.developer.nvidia.com/t/nvidia-driver-compatibility-with-linux-kernel-6-17-debian-trixie/354354)
- NixOS: PyPI torch cannot find `libcuda.so`; fixes are `LD_LIBRARY_PATH=/run/opengl-driver/lib` or `programs.nix-ld.enable` with CUDA libs in `programs.nix-ld.libraries`; "Found no NVIDIA driver" error with uv + nix-ld reported; driver mismatch after `nixos-rebuild switch` until reboot (issue #255070). — [NixOS Discourse: installing PyTorch in venv](https://discourse.nixos.org/t/installing-pytorch-into-a-virtual-python-environment/34720); [uv + nix-ld thread](https://discourse.nixos.org/t/python-uv-nix-ld-runtimeerror-found-no-nvidia-driver-on-your-system/71503); [uv without nix thread](https://discourse.nixos.org/t/how-to-use-pytorch-with-cuda-using-uv-without-nix/62801); [nixpkgs #255070](https://github.com/NixOS/nixpkgs/issues/255070); [pydevtools uv on NixOS](https://pydevtools.com/handbook/how-to/how-to-use-uv-on-nixos/)

### Inferences
- On Debian 13 with the stock 550 driver, you must pin to cu126 wheels. The full 12.6u3 minimum is 560.35.05, but 12.x minor-version compatibility needs only >= 525, so cu126 should run on 550 (possible PTX-JIT limits). cu130 (default from 2.11) will fail. cu126 ends at PyTorch 2.15, so Debian stock has a dated ceiling.
- On Fedora 43 (580), CachyOS 580xx pin (this machine, 580.178.04), and anything newer, the default cu130 wheels work. Newer wheels like cu132 need R595+ under strict reading, but minor-version compatibility (>= 580 for all 13.x) should cover them except features needing PTX JIT from a newer toolkit.
- A system CUDA toolkit is only needed for compiling custom CUDA extensions (flash-attn from source, `torch.utils.cpp_extension`). Then the toolkit version should match the wheel's CUDA major.

### Gaps
- The pytorch.org get-started page is JS-rendered; I could not read the current stable version and selector options directly. PyTorch version as of Nov 2026 (2.14 or 2.15?) not confirmed from a primary source.
- PyTorch does not publish an explicit "minimum driver" line per wheel; numbers come from NVIDIA's CUDA table.

## Training while the desktop runs on the same GPU; AMD iGPU for desktop + NVIDIA for compute

### Takeaway
I found no source showing a distro-specific difference for compute-while-desktop on the same NVIDIA GPU; behaviour depends on driver branch and compositor, not distro packaging. Running the desktop on an AMD iGPU and using the NVIDIA card only for CUDA is a standard, simple setup on every distro listed, because CUDA does not need the display path at all.

### Cited Findings
- No 2025-2026 source compared distros on this point. (Search done; nothing found.)
- Open modules are a license change for the kernel module; CUDA userspace stays proprietary and identical across distros. — [Bazzite discourse comment](https://universal-blue.discourse.group/t/bazzite-dx-nvidia-open-missing/11058/3)
- Fedora F43 Kinoite + Framework 16 hybrid: dGPU not activated, fullscreen dGPU apps show black screen (2026) — the display-offload path, not CUDA, is where hybrid bugs show up. — [Fedora thread](https://discussion.fedoraproject.org/t/43-kinoite-on-framework-16-nvidia-drivers-are-installed-and-detected-but-dgpu-is-not-activated-and-fullscreen-dgpu-applications-only-show-black-screen/188476)
- Fedora 42 hybrid (MX350) failed to boot after kernel update — hybrid laptops add kernel-update risk on Fedora too. — [Fedora thread](https://discussion.fedoraproject.org/t/nvidia-driver-fails-to-boot-on-kernel-update-in-fedora-42-hybrid-graphics-mx350/153763)
- 2026 CachyOS AMD iGPU black screens came from `linux-firmware-amdgpu` — moving the desktop to the iGPU moves the risk to AMD firmware, not removes it. — [CachyOS thread](https://discuss.cachyos.org/t/black-screen-after-update-linux-firmware-amdgpu-1-20260910-1-on-radeon-680m/35988)

### Inferences
- Same GPU for desktop and training: VRAM is shared (KDE Wayland plus a browser use roughly 0.5-1.5 GB), and heavy kernels can cause desktop stutter. This is the same on all distros. (This user's memory note on "~23 GB max, leave 1 GB for OS" matches this.)
- Desktop on Radeon 610M, NVIDIA for compute: plug monitors into the motherboard, enable the iGPU in BIOS, keep the NVIDIA driver installed; `nvidia-smi` and PyTorch see the card with no PRIME config, since PRIME render offload (`__NV_PRIME_RENDER_OFFLOAD=1`) is only for drawing apps on the dGPU. Gains: full 24 GB VRAM for training, no desktop stutter. Cost: the 610M is weak (2 CUs), so heavy compositor effects (blur, glass) may lag.

### Gaps
- No primary source fetched on PRIME offload status per distro in 2026 (Arch wiki PRIME page not fetched). Treat the iGPU notes as inference.
- No measurement of the 610M driving a 1440p high-refresh KDE Wayland desktop.

## Driver version shipped per distro (Nov 2026) and update speed; short notes on Bazzite, Nobara, Arch, NixOS, Debian 13

### Takeaway
As of mid-Nov 2026 the newest NVIDIA branch is R620 (CUDA 13.5). CachyOS, Arch (same upstream), Fedora 44 and Bazzite all ship 620.70.06 within days of release. Fedora 43 stays on 580. Debian 13 stock stays on 550. NixOS tracks via nixpkgs channels (not checked).

### Cited Findings
| Distro | Driver (Nov 2026) | Source |
|---|---|---|
| CachyOS | nvidia-utils 620.70.06-2, built 7 Nov 2026 | [packages.cachyos.org](https://packages.cachyos.org/package/cachyos-v3/x86_64_v3/nvidia-utils) |
| Fedora 44 (RPM Fusion) | akmod-nvidia 620.70.06, 5 Nov 2026 | [RPM Fusion F44](https://download1.rpmfusion.org/nonfree/fedora/updates/44/x86_64/repoview/akmod-nvidia.html) |
| Fedora 43 (RPM Fusion) | akmod-nvidia 580.196.07, 9 Nov 2026 | [RPM Fusion F43](https://download1.rpmfusion.org/nonfree/fedora/updates/43/x86_64/repoview/akmod-nvidia.html) |
| Bazzite (Fedora-based image) | Nov 2026 release with kernel 7.3 and NVIDIA 620 | [linuxcompatible.org](https://www.linuxcompatible.org/story/bazzite-linux-4520261111-now-available-with-linux-73-kernel-and-nvidia-620-drivers/) |
| Debian 13 | 550.163.01 (stable and backports) | [Debian NEW](https://ftp-master.debian.org/new/nvidia-graphics-drivers_550.163.01-4~bpo13+1.html) |
| This machine (CachyOS, pinned) | nvidia-580xx-dkms 580.178.04 | local `nvidia-smi`, 2026-11-20 |

- Bazzite: separate `-nvidia-open` image for Turing and newer (RTX 3090 qualifies); driver is baked into the image, so no local build; ships Distrobox. — [Bazzite FAQ](https://docs.bazzite.gg/General/FAQ/?h=nvidia); [Bazzite GitHub](https://github.com/ublue-os/bazzite)
- Arch: since 590, `nvidia` replaced by `nvidia-open`; Pascal and older moved to legacy. — [Arch news](https://archlinux.org/news/nvidia-590-driver-drops-pascal-support-main-packages-switch-to-open-kernel-modules/)

### Inferences
- Update speed ranking: CachyOS ≈ Arch ≈ Fedora 44 (days) > Bazzite (next image build, days to a week) > Fedora 43 (legacy branch on purpose) > Debian 13 (550, months/years behind; use NVIDIA CUDA repo to get newer).
- Bazzite's image model (driver built in CI, atomic rollback) removes both Fedora's akmods timing risk and CachyOS's lockstep risk, at the cost of training work happening inside Distrobox or a uv venv in $HOME (uv in $HOME works fine on an immutable host).
- Nobara: Fedora-based with NVIDIA drivers preinstalled; no 2026 source checked.

### Gaps
- Nobara: no 2025-2026 source fetched (version, packaging method).
- NixOS: current `nvidiaPackages.stable` / `latest` versions in nixos-25.11 / unstable not checked.
- Arch `nvidia-open` exact Nov 2026 version not fetched (inferred same as CachyOS).
- Bazzite source is an aggregator (linuxcompatible.org), not the Bazzite changelog.
