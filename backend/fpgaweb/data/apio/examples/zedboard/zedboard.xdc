
#-- zedboard board

#-- System clock (100 MHz)
set_property -dict { PACKAGE_PIN Y9    IOSTANDARD LVCMOS33 } [get_ports {clk}]

#-- LEDs
set_property -dict { PACKAGE_PIN T22   IOSTANDARD LVCMOS33 } [get_ports {leds[0]}]
set_property -dict { PACKAGE_PIN T21   IOSTANDARD LVCMOS33 } [get_ports {leds[1]}]
set_property -dict { PACKAGE_PIN U22   IOSTANDARD LVCMOS33 } [get_ports {leds[2]}]
set_property -dict { PACKAGE_PIN U21   IOSTANDARD LVCMOS33 } [get_ports {leds[3]}]

#-- Pin source: Digilent/digilent-xdc Zedboard-Master.xdc (GCLK, LD0-LD3)
