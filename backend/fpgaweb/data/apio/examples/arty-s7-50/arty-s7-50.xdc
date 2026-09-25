
#-- arty-s7-50 board

#-- System clock (12 MHz)
set_property -dict { PACKAGE_PIN F14   IOSTANDARD LVCMOS33 } [get_ports {clk}]

#-- LEDs
set_property -dict { PACKAGE_PIN E18   IOSTANDARD LVCMOS33 } [get_ports {leds[0]}]
set_property -dict { PACKAGE_PIN F13   IOSTANDARD LVCMOS33 } [get_ports {leds[1]}]
set_property -dict { PACKAGE_PIN E13   IOSTANDARD LVCMOS33 } [get_ports {leds[2]}]
set_property -dict { PACKAGE_PIN H15   IOSTANDARD LVCMOS33 } [get_ports {leds[3]}]

#-- Pin source: Digilent/digilent-xdc Arty-S7-50-Master.xdc
