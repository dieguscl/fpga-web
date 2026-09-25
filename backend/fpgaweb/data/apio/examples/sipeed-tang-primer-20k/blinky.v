//------------------------------------------------------------------
// Blink the top bar (segment A) of the right-hand digit.
//
// Board : Sipeed Tang Primer 20K Lite (GW2A-LV18PG256C8/I7)
// PMOD  : icebreaker 7-seg display v1.1a, top-right connector
// Clock : 27 MHz on H11
//
// Copyright (c) 2026 Carlos Venegas <carlos@magnitude.es>
// X: @cavearr  github: @cavearr
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
// PMOD map (Digilent 2x6, looking into the Lite header):
//
//   1 AA T6   2 AB T7   3 AC T8   4 AD T9   5 GND   6 3V3
//   7 AE P6   8 AF R8   9 AG P8  10 CAT P9 11 GND  12 3V3
//
//          AAA                 seven_seg[0] = AA (this example blinks it)
//         F   B                seven_seg[1] = AB
//         F   B                seven_seg[2] = AC
//          GGG                 seven_seg[3] = AD
//         E   C                seven_seg[4] = AE
//         E   C                seven_seg[5] = AF
//          DDD                 seven_seg[6] = AG
//                              seven_seg[7] = CAT
//
// Segments are active-low. CAT=1 selects the right-hand digit.
//------------------------------------------------------------------

module blinky #(
    // Num of click cycle per led toggle.
    parameter integer DIV = (27000000 / 2)
) (
    input        sys_clk,
    output [7:0] seven_seg  // {CAT, AG, AF, AE, AD, AC, AB, AA}
);

  // icebreaker 7-seg PMOD v1.1a: segments are active low. CAT=1 selects
  // the right-hand digit (workshop mapping). Other segments stay off.
  // seven_seg[0] (AA, top bar) blinks.

  reg led = 1;

  assign seven_seg[0]   = led;
  assign seven_seg[6:1] = 6'b111111;
  assign seven_seg[7]   = 1'b1;

  // ---- Reset generator.

  reg [3:0] reset_counter = 0;
  reg sys_reset = 1;

  always @(posedge sys_clk) begin
    if (reset_counter < 3) begin
      sys_reset <= 1;
      reset_counter <= reset_counter + 1;
    end else begin
      sys_reset <= 0;
    end
  end

  // ---- Blinker

  reg [31:0] blink_counter;

  always @(posedge sys_clk) begin
    if (sys_reset) begin
      blink_counter <= 0;
      led <= 1;
    end else begin
      if (blink_counter < (DIV - 1)) begin
        blink_counter <= blink_counter + 1;
      end else begin
        blink_counter <= 0;
        led <= ~led;
      end
    end
  end

endmodule
