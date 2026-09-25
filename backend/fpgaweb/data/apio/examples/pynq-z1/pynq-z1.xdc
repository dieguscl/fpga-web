
#-- pynq-z1 board

#-- System clock (125 MHz)
set_property -dict { PACKAGE_PIN H16   IOSTANDARD LVCMOS33 } [get_ports {clk}]

#-- LEDs
set_property -dict { PACKAGE_PIN R14   IOSTANDARD LVCMOS33 } [get_ports {leds[0]}]
set_property -dict { PACKAGE_PIN P14   IOSTANDARD LVCMOS33 } [get_ports {leds[1]}]
set_property -dict { PACKAGE_PIN N16   IOSTANDARD LVCMOS33 } [get_ports {leds[2]}]
set_property -dict { PACKAGE_PIN M14   IOSTANDARD LVCMOS33 } [get_ports {leds[3]}]

#-- Pin source: LEDs: Xilinx/PYNQ base.xdc; 125 MHz PL clock H16: Pynq-Z1 reference manual
