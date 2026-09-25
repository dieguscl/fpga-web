
#-- Arty A7-35T board

#-- System clock (100 MHz)
set_property -dict { PACKAGE_PIN Y18    IOSTANDARD LVCMOS33 } [get_ports {CLK}]

#-- LEDs
set_property -dict { PACKAGE_PIN F19    IOSTANDARD LVCMOS33 } [get_ports {LEDS[0]}]
set_property -dict { PACKAGE_PIN E21    IOSTANDARD LVCMOS33 } [get_ports {LEDS[1]}]
set_property -dict { PACKAGE_PIN D20    IOSTANDARD LVCMOS33 } [get_ports {LEDS[2]}]
set_property -dict { PACKAGE_PIN C20    IOSTANDARD LVCMOS33 } [get_ports {LEDS[3]}]

#-- Pin source: Digilent/digilent-xdc Arty-A7-35-Master.xdc
