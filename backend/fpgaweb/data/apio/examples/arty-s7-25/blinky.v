`default_nettype none

//-- Blinking led (12 MHz clock -> ~1 Hz on LED0)
module main (
    input clk,
    output wire [3:0] leds
);

  //-- 24-bit counter
  reg [23:0] counter;
  always @(posedge clk) begin
    counter <= counter + 1;
  end

  //-- Show the counter MSB on LED0
  assign leds[0]   = counter[23];

  assign leds[3:1] = 0;

  //-- This is for simulation
  //-- the counter should start in 0
  initial begin
    counter = 0;
  end

endmodule
