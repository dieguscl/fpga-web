
module main #(
    // The macro N is defined in apio.ini
    parameter integer N = `N
) (
    input  CLK,     // 50MHz clock
    output [3:0] LEDS // Active low
);

  reg [31:0] counter = 0;

  reg led = 0;

  // Leds are active low.
  assign LEDS[3] = led;
  assign LEDS[2] = !led;
  assign LEDS[1] = 1'b1;
  assign LEDS[0] = 1'b1;

  always @(posedge CLK) begin
    if (counter >= N - 1) begin
      counter <= 0;
      led <= !led;
    end else begin
      counter <= counter + 1;
    end
  end

endmodule


