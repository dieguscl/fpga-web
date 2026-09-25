
`timescale 1ns / 1ps

module testbench;

  // Clock and DUT signals
  reg CLK = 0;
  wire [3:0] LEDS;

  // Instantiate DUT with N = 3 for quick testing
  main #(
      .N(3)
  ) dut (
      .CLK (CLK),
      .LEDS(LEDS)
  );

  // Generate 12 MHz-like clock (approx. 83 ns period)
  always #42 CLK = ~CLK;

  // Expected state tracker
  reg expected_led = 0;
  reg [3:0] expected_leds = 4'b0111;

  integer i;

  initial begin
    $dumpvars(0, testbench);

    // Simulate 12 rising edges of CLK
    for (i = 0; i < 12; i = i + 1) begin
      @(posedge CLK);

      // Check LED values before updating expected state

      if (LEDS !== expected_leds) begin
        $display("ERROR at cycle %0d: LEDS = %b, expected = %b", i, LEDS, expected_leds);
        if (!`APIO_SIM) $fatal(1, "LED state mismatch");
      end

      // Update expected LED every N=3 cycles
      if ((i + 1) % 3 == 0) begin
        expected_led  = ~expected_led;
        expected_leds = {expected_led, ~expected_led, 2'b11};
      end
    end

    $finish;
  end

endmodule
