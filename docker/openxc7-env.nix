# openXC7 tool environment, pinned through the tools-openxc7 flake checked out at /src.
# Produces: bin/{nextpnr-xilinx,xc7frames2bit,fasm2frames} and prjxray-db/ (symlinks into /nix/store).
let
  flake = builtins.getFlake "git+file:///src";
  system = builtins.currentSystem;
  p = flake.packages.${system};
  pkgs = flake.inputs.nixpkgs.legacyPackages.${system};
  py = pkgs.python312.withPackages (ps: with ps; [ pyyaml textx simplejson intervaltree sortedcontainers arpeggio ]);
  sitePackages = pkg: "${pkg}/${pkgs.python312.sitePackages}";
in
pkgs.runCommand "openxc7-tools" { } ''
  mkdir -p $out/bin
  ln -s ${p.nextpnr-xilinx}/bin/nextpnr-xilinx $out/bin/
  ln -s ${p.prjxray}/bin/xc7frames2bit $out/bin/
  cat > $out/bin/fasm2frames <<'EOF'
  #!${pkgs.runtimeShell}
  export PYTHONPATH=${p.prjxray}/usr/share/python3:${sitePackages p.fasm}
  exec ${py}/bin/python3 ${p.prjxray}/bin/fasm2frames "$@"
  EOF
  chmod +x $out/bin/fasm2frames
  ln -s ${p.nextpnr-xilinx}/share/nextpnr/external/prjxray-db $out/prjxray-db
''
